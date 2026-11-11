import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/client.js";
import { DEMO_CLIENT_ID, DEMO_WORKER_ID, seedDemoParties } from "../src/db/seed.js";
import { loadKeyring } from "../src/qaps/keys.js";
import { verifierIds } from "../src/qaps/protocol.js";
import { ISSUER_ID, verifyReceipt } from "../src/qaps/receipt.js";
import { createApp } from "../src/server/app.js";
import { partyToken } from "../src/server/auth.js";
import { buildVerifier } from "../src/server/verifier.js";
import { EvidenceStore } from "../src/verifier/evidence-store.js";
import { MockRail } from "./helpers/qaps.js";

const SECRET = "trust-test-secret-0123456789";
const CONTRACT = JSON.parse(readFileSync(new URL("../demo/contract.json", import.meta.url), "utf8")) as { total_cents: number };
let server: Server;
let base: string;
let rail: MockRail;

beforeAll(async () => {
  const holder: { app?: ReturnType<typeof createApp> } = {};
  server = createServer((req, res) => holder.app!(req, res)).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = loadConfig({ MCP_AUTH_TOKEN: SECRET, PUBLIC_BASE_URL: base, PORT: new URL(base).port, PAYMENT_RAIL: "auth_capture" });
  const db = openDb(":memory:");
  seedDemoParties(db, loadConfig({ DEMO_CLIENT_EMAIL: "c@example.com", DEMO_WORKER_EMAIL: "w@example.com" }));
  const keyring = loadKeyring(verifierIds(3), { dir: mkdtempSync(join(tmpdir(), "kept-trust-keys-")) });
  const issuer = loadKeyring([ISSUER_ID], { dir: mkdtempSync(join(tmpdir(), "kept-trust-iss-")) }).get(ISSUER_ID)!;
  const evidence = new EvidenceStore(mkdtempSync(join(tmpdir(), "kept-trust-ev-")));
  rail = new MockRail();
  holder.app = createApp(config, { db, keyring, issuer, evidence, rail, verify: buildVerifier(config, keyring, evidence) });
});
afterAll(() => new Promise((r) => server.close(r)));

async function call(method: string, path: string, as?: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(as ? { authorization: `Bearer ${partyToken(SECRET, as)}` } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** A job taken to VERIFIED on the given demo site. */
async function verifiedJob(site: "good" | "flawed") {
  const job = (await call("POST", "/jobs", DEMO_CLIENT_ID, { title: "Site", brief: "Bakery site", worker_id: DEMO_WORKER_ID, budget_cents: CONTRACT.total_cents, checklist: CONTRACT })).body;
  for (const p of [DEMO_CLIENT_ID, DEMO_WORKER_ID]) await call("POST", `/jobs/${job.id}/accept`, p, { checklist_hash: job.checklist_hash });
  await call("POST", `/jobs/${job.id}/lock`, DEMO_CLIENT_ID, {});
  const funded = (await call("POST", `/jobs/${job.id}/confirm`, DEMO_CLIENT_ID, {})).body;
  await call("POST", `/jobs/${job.id}/submit`, DEMO_WORKER_ID, { deliverable_url: `${base}/demo/sites/${site}/` });
  const v = await call("POST", `/jobs/${job.id}/verify?wait=1`, DEMO_WORKER_ID, {});
  expect(v.body.job.status).toBe("VERIFIED");
  return { id: job.id as string, funded };
}

describe("T6: hold limit, resubmission, disputes", () => {
  it("shows when PayPal moves held money on its own (auth_capture: 29 days)", async () => {
    const { id, funded } = await verifiedJob("good");
    expect(funded.hold).toMatchObject({ limit_days: 29 });
    const ms = new Date(funded.hold.expires_at).getTime() - new Date(funded.hold.funded_at).getTime();
    expect(ms).toBe(29 * 86_400_000);
    expect(funded.hold.rule).toMatch(/authorization/);
    await call("POST", `/jobs/${id}/settle`, DEMO_CLIENT_ID, {});
    expect((await call("GET", `/jobs/${id}`)).body.hold).toBeNull();
  }, 90_000);

  it("the worker fixes a failed milestone once: a new round verifies the whole contract, then all four milestones are paid", async () => {
    const { id } = await verifiedJob("flawed");
    const before = (await call("GET", `/jobs/${id}`)).body;
    expect(before.milestones.map((m: { outcome: string }) => m.outcome)).toEqual(["passed", "passed", "failed", "passed"]);
    expect(before.resubmissions_left).toBe(1);

    expect((await call("POST", `/jobs/${id}/resubmit`, DEMO_CLIENT_ID, { deliverable_url: `${base}/demo/sites/good/` })).status).toBe(403);
    const re = await call("POST", `/jobs/${id}/resubmit`, DEMO_WORKER_ID, { deliverable_url: `${base}/demo/sites/good/` });
    expect(re.status).toBe(200);
    expect(re.body).toMatchObject({ status: "DELIVERED", resubmissions_left: 0, deliverable_url: `${base}/demo/sites/good/` });
    const v2 = await call("POST", `/jobs/${id}/verify?wait=1`, DEMO_WORKER_ID, {});
    expect(v2.body.summary.round).toBe(2);
    expect(v2.body.summary.outcomes).toEqual(["passed", "passed", "passed", "passed"]);

    const s = await call("POST", `/jobs/${id}/settle`, DEMO_CLIENT_ID, {});
    expect(s.body.settlement.releasedCents).toBe(10000);
    const receipt = (await call("GET", `/jobs/${id}/receipt`)).body;
    expect(verifyReceipt(receipt).ok).toBe(true);
    expect(receipt.certificate.deliverable_url).toBe(`${base}/demo/sites/good/`);
  }, 120_000);

  it("only once, and only when something failed", async () => {
    const good = await verifiedJob("good");
    expect((await call("POST", `/jobs/${good.id}/resubmit`, DEMO_WORKER_ID, { deliverable_url: `${base}/demo/sites/good/` })).body.error).toMatch(/no milestone failed/);
    const flawed = await verifiedJob("flawed");
    await call("POST", `/jobs/${flawed.id}/resubmit`, DEMO_WORKER_ID, { deliverable_url: `${base}/demo/sites/flawed/` });
    await call("POST", `/jobs/${flawed.id}/verify?wait=1`, DEMO_WORKER_ID, {});
    const again = await call("POST", `/jobs/${flawed.id}/resubmit`, DEMO_WORKER_ID, { deliverable_url: `${base}/demo/sites/good/` });
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/at most 1/);
  }, 120_000);

  it("a dispute pauses settlement; only the party who opened it can withdraw it", async () => {
    const { id } = await verifiedJob("flawed");
    const d = await call("POST", `/jobs/${id}/dispute`, DEMO_WORKER_ID, { reason: "The form works on my machine" });
    expect(d.body.status).toBe("DISPUTED");
    const moved = rail.moved.length;
    const blocked = await call("POST", `/jobs/${id}/settle`, DEMO_CLIENT_ID, {});
    expect(blocked.status).toBe(409);
    expect(rail.moved.length).toBe(moved);
    expect((await fetch(`${base}/jobs/${id}/report`)).status).toBe(200);
    expect((await call("GET", `/jobs/${id}/receipt`)).status).toBe(200);
    expect((await call("POST", `/jobs/${id}/dispute/withdraw`, DEMO_CLIENT_ID, {})).status).toBe(403);
    expect((await call("POST", `/jobs/${id}/dispute/withdraw`, DEMO_WORKER_ID, {})).body.status).toBe("VERIFIED");
    expect((await call("POST", `/jobs/${id}/settle`, DEMO_CLIENT_ID, {})).body.job.status).toBe("SETTLED");
    expect((await call("POST", `/jobs/${id}/dispute`, DEMO_CLIENT_ID, { reason: "late" })).status).toBe(409);
  }, 90_000);
});
