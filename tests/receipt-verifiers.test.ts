import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadProofFromDb, recordClientDecision } from "../src/core/proof-store.js";
import { getReceipt } from "../src/core/receipt-store.js";
import { settleJob } from "../src/core/settlement.js";
import { openDb, type Db } from "../src/db/client.js";
import { seedDemoParties } from "../src/db/seed.js";
import { createDeliveredDemoJob } from "../src/demo/job.js";
import { loadKeyring } from "../src/qaps/keys.js";
import { verifierIds } from "../src/qaps/protocol.js";
import { ISSUER_ID, verifyReceipt as verifyTs, type ProofReceipt } from "../src/qaps/receipt.js";
import { createApp } from "../src/server/app.js";
import { panelBrowsers } from "../src/verifier/browser.js";
import { EvidenceStore } from "../src/verifier/evidence-store.js";
import { verifyJob } from "../src/verifier/orchestrator.js";
// The standalone verifier: a separate implementation with no dependencies.
// @ts-expect-error -- plain .mjs without type declarations, on purpose
import * as standalone from "../tools/verify-receipt.mjs";
import { MockRail } from "./helpers/qaps.js";

type Verify = (r: unknown, o?: { issuerFingerprint?: string }) => { ok: boolean; checks: { check: string; ok: boolean; detail: string }[] };
const verifyMjs = (standalone as { verifyReceipt: Verify }).verifyReceipt;
const run = promisify(execFile);
const STANDALONE = join(import.meta.dirname, "../tools/verify-receipt.mjs");
const ROOT = join(import.meta.dirname, "..");

let server: Server;
let origin: string;
let db: Db;
let jobId: string;
let receipt: ProofReceipt;
const keyring = loadKeyring(verifierIds(3), { dir: mkdtempSync(join(tmpdir(), "kept-rv-keys-")) });
const issuer = loadKeyring([ISSUER_ID], { dir: mkdtempSync(join(tmpdir(), "kept-rv-issuer-")) }).get(ISSUER_ID)!;
const store = new EvidenceStore(mkdtempSync(join(tmpdir(), "kept-rv-ev-")));

/** A real receipt: three verifiers on two engines check the flawed demo site, then settlement on the mock rail. */
beforeAll(async () => {
  db = openDb(":memory:");
  seedDemoParties(db, loadConfig({ DEMO_CLIENT_EMAIL: "c@example.com", DEMO_WORKER_EMAIL: "w@example.com" }));
  // Listen first, so the app's PUBLIC_BASE_URL (used in artifact URLs) is this server's real address.
  const holder: { app?: ReturnType<typeof createApp> } = {};
  server = createServer((req, res) => holder.app!(req, res)).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  holder.app = createApp(loadConfig({ PUBLIC_BASE_URL: origin }), { db, keyring, issuer, evidence: store });
  jobId = createDeliveredDemoJob(db, { keyring, deliverableUrl: `${origin}/demo/sites/flawed/` });
  const summary = await verifyJob(db, jobId, {
    keyring,
    store,
    network: { allowOrigins: [origin] },
    panel: (ids, url) => panelBrowsers(ids, { preferKernel: false, deliverableUrl: url }),
    judgeModels: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    checkTimeoutMs: 8000,
  });
  for (const item of summary.items!.filter((x) => x.verdict === "needs_client")) {
    recordClientDecision(db, { jobId, m: item.m, i: item.i, decision: "approve", actor: "party_demo_client" });
  }
  await settleJob(db, jobId, { rail: new MockRail(), loadProof: loadProofFromDb, actor: "kept" });
  receipt = getReceipt(db, jobId, { publicBaseUrl: origin, issuer });
}, 120_000);
afterAll(() => new Promise((r) => server.close(r)));

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Every leaf value in the receipt, as a path of keys and indexes. */
function leafPaths(v: unknown, path: (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(v)) return v.length ? v.flatMap((x, i) => leafPaths(x, [...path, i])) : [path];
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v);
    return keys.length ? keys.flatMap((k) => leafPaths((v as Record<string, unknown>)[k], [...path, k])) : [path];
  }
  return [path];
}

/** Changes one value minimally: a string's last character, a number by one, a boolean flipped, null to a string. */
function mutateAt(root: unknown, path: (string | number)[]): void {
  let parent = root as Record<string | number, unknown>;
  for (const k of path.slice(0, -1)) parent = parent[k] as Record<string | number, unknown>;
  const key = path[path.length - 1]!;
  const v = parent[key];
  if (typeof v === "string") parent[key] = v.length ? v.slice(0, -1) + (v.endsWith("0") ? "1" : "0") : "x";
  else if (typeof v === "number") parent[key] = v + 1;
  else if (typeof v === "boolean") parent[key] = !v;
  else if (v === null) parent[key] = "x";
  else if (Array.isArray(v)) v.push("x");
  else (v as Record<string, unknown>).x = "x";
}

describe("Proof Receipt verifiers (Kept's TypeScript one and the standalone .mjs)", () => {
  it("both accept the real receipt, with and without the published issuer key", () => {
    for (const verify of [verifyTs, verifyMjs]) {
      const plain = verify(receipt);
      expect(plain.checks.filter((c) => !c.ok)).toEqual([]);
      expect(verify(receipt, { issuerFingerprint: issuer.public.fingerprint }).ok).toBe(true);
    }
    // Same checks, same order, same verdicts.
    expect(verifyMjs(receipt).checks.map((c) => [c.check, c.ok])).toEqual(verifyTs(receipt).checks.map((c) => [c.check, c.ok]));
  });

  it("changing any single field of the real receipt fails both, and the seal names the section", () => {
    const paths = leafPaths(receipt).filter((p) => p.length > 0);
    expect(paths.length).toBeGreaterThan(300);
    const missed: string[] = [];
    for (const path of paths) {
      const r = clone(receipt);
      mutateAt(r, path);
      const where = path.join(".");
      for (const [name, verify] of [["ts", verifyTs], ["mjs", verifyMjs]] as const) {
        const res = verify(r);
        if (res.ok) {
          missed.push(`${name}: ${where} accepted`);
          continue;
        }
        const formatOk = res.checks.find((c) => c.check === "format")?.ok;
        if (!formatOk || path[0] === "seal") continue; // rejected as malformed, or the seal itself was edited
        const sections = res.checks.find((c) => c.check === "seal_sections");
        if (sections?.ok !== false || !sections.detail.split(/[ ,:]+/).includes(String(path[0]))) {
          missed.push(`${name}: ${where} rejected without naming section ${path[0]} (${JSON.stringify(sections)})`);
        }
      }
      // The two implementations must agree that it is invalid and on whether it was malformed.
      const [a, b] = [verifyTs(r), verifyMjs(r)];
      if (a.checks[0]!.ok !== b.checks[0]!.ok) missed.push(`format disagreement at ${where}: ts=${a.checks[0]!.ok} mjs=${b.checks[0]!.ok}`);
    }
    expect(missed).toEqual([]);
    // Hundreds of mutations × two verifiers: CPU-bound, slow when sharing the machine with browser tests.
  }, 120_000);

  it("standalone: runs with plain node in an empty folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kept-standalone-"));
    copyFileSync(STANDALONE, join(dir, "verify-receipt.mjs"));
    writeFileSync(join(dir, "receipt.json"), JSON.stringify(receipt));
    const ok = await run(process.execPath, ["verify-receipt.mjs", "receipt.json", "--issuer", issuer.public.fingerprint], { cwd: dir });
    expect(ok.stdout).toMatch(/VALID: every check passed/);
    expect(ok.stdout).toMatch(/issuer key compared with --issuer/);
    expect(ok.stdout).toContain(`custom_id = ${receipt.contract_hash}`);

    const tampered = clone(receipt);
    tampered.milestones[1]!.outcome = tampered.milestones[1]!.outcome === "passed" ? "failed" : "passed";
    writeFileSync(join(dir, "tampered.json"), JSON.stringify(tampered));
    const bad = await run(process.execPath, ["verify-receipt.mjs", "tampered.json"], { cwd: dir }).catch((e: { code: number; stdout: string }) => e);
    expect(bad).toMatchObject({ code: 1 });
    expect((bad as { stdout: string }).stdout).toMatch(/FAIL {2}seal_sections +changed since sealing: milestones/);
    expect((bad as { stdout: string }).stdout).toMatch(/FAIL {2}milestones +milestone 1 says/);
    expect((bad as { stdout: string }).stdout).toMatch(/INVALID/);

    const usage = await run(process.execPath, ["verify-receipt.mjs"], { cwd: dir }).catch((e: { code: number }) => e);
    expect(usage).toMatchObject({ code: 2 });
  });

  it("standalone and npm run verify-receipt: verify by URL, checking the published issuer key and every artifact's bytes", async () => {
    const url = `${origin}/jobs/${jobId}/receipt`;
    const mjs = await run(process.execPath, [STANDALONE, url]);
    const ts = await run(process.execPath, ["--import", "tsx", "scripts/verify-receipt.ts", url], { cwd: ROOT });
    for (const out of [mjs.stdout, ts.stdout]) {
      expect(out).toMatch(/PASS {2}issuer_key/);
      expect(out).toMatch(/PASS {2}artifact_bytes +downloaded \d+ artifacts, every one hashes to its name/);
      expect(out).toMatch(/issuer key compared with http:\/\/127\.0\.0\.1:\d+\/\.well-known\/kept\/issuer\.json/);
      expect(out).toMatch(/VALID: every check passed/);
    }
  }, 60_000);

  it("a corrupted artifact on the server is caught by the byte check", async () => {
    const a = receipt.artifacts.find((x) => x.kind === "json")!;
    const fakeFetch = async (u: string) => (u === a.url ? new Response("not the evidence") : fetch(u));
    const res = await (standalone as { verifyArtifacts: (r: unknown, f: typeof fakeFetch) => Promise<{ ok: boolean; detail: string }> }).verifyArtifacts(receipt, fakeFetch);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain(`${a.sha256}.json: content hashes to`);
  });
});
