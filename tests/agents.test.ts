import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBuyer } from "../agents/buyer.js";
import { connectAgent, ToolError, type ToolData } from "../agents/kept-agent.js";
import { reviewChecklist, runWorker } from "../agents/worker.js";
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

const SECRET = "agents-test-secret-0123456789";
const CONTRACT = JSON.parse(readFileSync(new URL("../demo/contract.json", import.meta.url), "utf8")) as ToolData;
let server: Server;
let base: string;
const rail = new MockRail();

beforeAll(async () => {
  const holder: { app?: ReturnType<typeof createApp> } = {};
  server = createServer((req, res) => holder.app!(req, res)).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = loadConfig({ MCP_AUTH_TOKEN: SECRET, PUBLIC_BASE_URL: base, PORT: new URL(base).port, DEMO_CLIENT_EMAIL: "c@example.com", DEMO_WORKER_EMAIL: "w@example.com" });
  const db = openDb(":memory:");
  seedDemoParties(db, config);
  const keyring = loadKeyring(verifierIds(3), { dir: mkdtempSync(join(tmpdir(), "kept-ag-keys-")) });
  const issuer = loadKeyring([ISSUER_ID], { dir: mkdtempSync(join(tmpdir(), "kept-ag-iss-")) }).get(ISSUER_ID)!;
  const evidence = new EvidenceStore(mkdtempSync(join(tmpdir(), "kept-ag-ev-")));
  holder.app = createApp(config, { db, keyring, issuer, evidence, rail, verify: buildVerifier(config, keyring, evidence) });
});
afterAll(() => new Promise((r) => server.close(r)));

describe("demo agents (MCP clients)", () => {
  it("the worker refuses a contract that does not add up", () => {
    expect(reviewChecklist({ total_cents: 10000, currency: "USD", checklist: CONTRACT })).toBeUndefined();
    expect(reviewChecklist({ total_cents: 9000, currency: "USD", checklist: CONTRACT })).toMatch(/do not add up/);
    expect(reviewChecklist({ total_cents: 10000, currency: "EUR", checklist: CONTRACT })).toMatch(/currency/);
  });

  it("buyer and worker run a whole job on the good site: every milestone released, receipt verifies", async () => {
    const buyer = await connectAgent(base, partyToken(SECRET, DEMO_CLIENT_ID), "buyer");
    const worker = await connectAgent(base, partyToken(SECRET, DEMO_WORKER_ID), "worker");
    expect([buyer.partyId, worker.partyId]).toEqual([DEMO_CLIENT_ID, DEMO_WORKER_ID]);
    const lines: string[] = [];
    const stop = new AbortController();
    const w = runWorker(worker, { deliverableBase: base, site: "good", signal: stop.signal, pollMs: 100, log: (l) => lines.push(`worker: ${l}`) });
    const approvals: string[] = [];
    const r = await runBuyer(buyer, {
      goal: "A bakery website",
      budgetCents: CONTRACT.total_cents,
      workerId: DEMO_WORKER_ID,
      checklist: CONTRACT,
      pollMs: 100,
      log: (l) => lines.push(`buyer: ${l}`),
      onApproval: async (url) => void approvals.push(url),
    });
    stop.abort();
    await w;
    expect(approvals).toHaveLength(1);
    expect(r.verification.milestone_outcomes).toEqual(["passed", "passed", "passed", "passed"]);
    expect(r.job.status).toBe("SETTLED");
    expect(r.settlement.releasedCents).toBe(10000);
    expect(verifyReceipt(r.receipt).ok).toBe(true);
    expect(lines.some((l) => l.startsWith("worker: Delivering") || l.includes("Delivering the good site"))).toBe(true);
    await expect(buyer.call("get_job", { job_id: "job_nope" })).rejects.toBeInstanceOf(ToolError);
    await buyer.close();
    await worker.close();
  }, 120_000);
});
