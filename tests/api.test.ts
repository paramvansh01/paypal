import { readFileSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/client.js";
import { jobs, parties } from "../src/db/schema.js";
import { DEMO_CLIENT_ID, DEMO_WORKER_ID, seedDemoParties } from "../src/db/seed.js";
import { loadKeyring } from "../src/qaps/keys.js";
import { verifierIds } from "../src/qaps/protocol.js";
import { ISSUER_ID, verifyReceipt } from "../src/qaps/receipt.js";
import { createApp, type AppDeps } from "../src/server/app.js";
import { partyFromToken, partyToken } from "../src/server/auth.js";
import { EvidenceStore } from "../src/verifier/evidence-store.js";
import type { VerificationSummary } from "../src/verifier/orchestrator.js";
import { buildVerifier } from "../src/server/verifier.js";
import { MockRail } from "./helpers/qaps.js";

const SECRET = "test-secret-0123456789";
const STRANGER = "party_stranger";
const keyring = loadKeyring(verifierIds(3), { dir: mkdtempSync(join(tmpdir(), "kept-api-keys-")) });
const issuer = loadKeyring([ISSUER_ID], { dir: mkdtempSync(join(tmpdir(), "kept-api-issuer-")) }).get(ISSUER_ID)!;
const store = new EvidenceStore(mkdtempSync(join(tmpdir(), "kept-api-ev-")));
const CONTRACT = JSON.parse(readFileSync(new URL("../demo/contract.json", import.meta.url), "utf8")) as { total_cents: number; milestones: unknown[] };

let server: Server;
let base: string;
let db: Db;
let rail: MockRail;
const holder: { deps: Partial<AppDeps>; app?: ReturnType<typeof createApp> } = { deps: {} };

/** (Re)builds the app over a fresh database; the HTTP server and its port stay the same. */
function rebuild(over: Partial<AppDeps> = {}, env: Record<string, string> = {}) {
  db = openDb(":memory:");
  seedDemoParties(db, loadConfig({ DEMO_CLIENT_EMAIL: "c@example.com", DEMO_WORKER_EMAIL: "w@example.com" }));
  db.insert(parties).values({ id: STRANGER, kind: "agent", displayName: "Someone else" }).run();
  rail = new MockRail();
  const config = loadConfig({ MCP_AUTH_TOKEN: SECRET, PUBLIC_BASE_URL: base, PORT: new URL(base).port, ...env });
  holder.app = createApp(config, { db, keyring, issuer, evidence: store, rail, ...over });
}

beforeAll(async () => {
  server = createServer((req, res) => holder.app!(req, res)).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => rebuild());

const token = (party: string) => partyToken(SECRET, party);
async function call(method: string, path: string, as?: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(as ? { authorization: `Bearer ${token(as)}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const post = (path: string, as?: string, body: unknown = {}) => call("POST", path, as, body);

async function postJob(checklist: unknown = CONTRACT) {
  const res = await post("/jobs", DEMO_CLIENT_ID, {
    title: "Halcyon Crumb website",
    brief: "A bakery website with a menu and a working contact form.",
    worker_id: DEMO_WORKER_ID,
    budget_cents: CONTRACT.total_cents,
    checklist,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; checklist_hash: string };
}
async function agreedJob() {
  const job = await postJob();
  await post(`/jobs/${job.id}/accept`, DEMO_CLIENT_ID, { checklist_hash: job.checklist_hash });
  await post(`/jobs/${job.id}/accept`, DEMO_WORKER_ID, { checklist_hash: job.checklist_hash });
  return job;
}
async function deliveredJob(site = "good") {
  const job = await agreedJob();
  expect((await post(`/jobs/${job.id}/lock`, DEMO_CLIENT_ID)).status).toBe(200);
  expect((await post(`/jobs/${job.id}/confirm`, DEMO_CLIENT_ID)).status).toBe(200);
  expect((await post(`/jobs/${job.id}/submit`, DEMO_WORKER_ID, { deliverable_url: `${base}/demo/sites/${site}/` })).status).toBe(200);
  return job;
}

describe("party tokens", () => {
  it("round-trip, and any change to the party or the MAC is rejected", () => {
    const t = partyToken(SECRET, "party_a");
    expect(partyFromToken(SECRET, t)).toBe("party_a");
    expect(partyFromToken("other-secret", t)).toBeUndefined();
    expect(partyFromToken(SECRET, t.replace("party_a", "party_b"))).toBeUndefined();
    expect(partyFromToken(SECRET, t.slice(0, -1) + (t.endsWith("0") ? "1" : "0"))).toBeUndefined();
    expect(partyFromToken(SECRET, "nodot")).toBeUndefined();
  });

  it("writes need a valid token; reads are public", async () => {
    expect((await post("/jobs", undefined, {})).status).toBe(401);
    const bad = await fetch(`${base}/jobs`, { method: "POST", headers: { authorization: "Bearer party_demo_client.00" } });
    expect(bad.status).toBe(401);
    expect((await call("GET", "/jobs")).status).toBe(200);
  });

  it("writes are disabled (503) when MCP_AUTH_TOKEN is not set", async () => {
    rebuild({}, { MCP_AUTH_TOKEN: "" });
    const res = await post("/jobs", DEMO_CLIENT_ID, {});
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/MCP_AUTH_TOKEN/);
  });
});

describe("posting and agreeing a job", () => {
  it("the server sets the verifier panel; both parties accept the same hash; then it is frozen", async () => {
    const job = await postJob();
    const view = (await call("GET", `/jobs/${job.id}`)).body;
    expect(view).toMatchObject({ status: "CHECKLIST_PROPOSED", client_id: DEMO_CLIENT_ID, worker_id: DEMO_WORKER_ID, checklist_frozen: false });
    expect(view.checklist.quorum).toEqual({
      n: 3,
      k: 2,
      verifiers: [...keyring.values()].map((k) => ({ id: k.id, public_key: k.public.public_key })),
    });

    const first = await post(`/jobs/${job.id}/accept`, DEMO_CLIENT_ID, { checklist_hash: job.checklist_hash });
    expect(first.body).toMatchObject({ agreed: false, job: { acceptances: { client: true, worker: false } } });
    const second = await post(`/jobs/${job.id}/accept`, DEMO_WORKER_ID, { checklist_hash: job.checklist_hash });
    expect(second.body).toMatchObject({ agreed: true, job: { status: "AGREED", checklist_frozen: true, checklist_hash: job.checklist_hash } });

    const edit = await call("PUT", `/jobs/${job.id}/checklist`, DEMO_CLIENT_ID, { checklist: CONTRACT });
    expect(edit.status).toBe(409);
    expect(edit.body.error).toMatch(/frozen/);
  });

  it("accepting a stale hash fails, and a revision makes earlier acceptances lapse", async () => {
    const job = await postJob();
    await post(`/jobs/${job.id}/accept`, DEMO_CLIENT_ID, { checklist_hash: job.checklist_hash });
    const revised = structuredClone(CONTRACT) as { milestones: { title: string }[] };
    revised.milestones[0]!.title = "Home page online";
    const put = await call("PUT", `/jobs/${job.id}/checklist`, DEMO_WORKER_ID, { checklist: revised });
    expect(put.status).toBe(200);
    expect(put.body.acceptances).toEqual({ client: false, worker: false });
    expect(put.body.checklist_hash).not.toBe(job.checklist_hash);

    const stale = await post(`/jobs/${job.id}/accept`, DEMO_WORKER_ID, { checklist_hash: job.checklist_hash });
    expect(stale.status).toBe(400);
    expect(stale.body.error).toMatch(/the checklist changed/);
  });

  it("rejects a client-supplied quorum, a budget mismatch, a missing worker and bad checklists", async () => {
    const withQuorum = { ...CONTRACT, quorum: { n: 1, k: 1, verifiers: [] } };
    for (const [body, pattern] of [
      [{ title: "t", brief: "b", worker_id: DEMO_WORKER_ID, budget_cents: 10000, checklist: withQuorum }, /must not contain `quorum`/],
      [{ title: "t", brief: "b", worker_id: DEMO_WORKER_ID, budget_cents: 9999, checklist: CONTRACT }, /does not match the budget/],
      [{ title: "t", brief: "b", worker_id: "party_nobody", budget_cents: 10000 }, /unknown worker/],
      [{ title: "t", brief: "b", worker_id: DEMO_CLIENT_ID, budget_cents: 10000 }, /different party/],
      [{ title: "t", brief: "b", worker_id: DEMO_WORKER_ID, budget_cents: 10000, checklist: { ...CONTRACT, total_cents: 1 } }, /milestone amounts add up/],
      [{ title: "", brief: "b", worker_id: DEMO_WORKER_ID, budget_cents: 10000 }, /title/],
    ] as const) {
      const res = await post("/jobs", DEMO_CLIENT_ID, body);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.error).toMatch(pattern);
    }
    const junk = await fetch(`${base}/jobs`, { method: "POST", headers: { authorization: `Bearer ${token(DEMO_CLIENT_ID)}`, "content-type": "application/json" }, body: "{" });
    expect(junk.status).toBe(400);
    expect((await junk.json()).error).toMatch(/not valid JSON/);
  });

  it("a job without a checklist stays DRAFT until one is proposed", async () => {
    const res = await post("/jobs", DEMO_CLIENT_ID, { title: "t", brief: "b", worker_id: DEMO_WORKER_ID, budget_cents: 10000 });
    expect(res.body).toMatchObject({ status: "DRAFT", checklist: null, checklist_hash: null });
    const put = await call("PUT", `/jobs/${res.body.id}/checklist`, DEMO_WORKER_ID, { checklist: CONTRACT });
    expect(put.body).toMatchObject({ status: "CHECKLIST_PROPOSED" });
  });
});

describe("who may do what, and when", () => {
  it("only the right party can act", async () => {
    const job = await postJob();
    expect((await post(`/jobs/${job.id}/accept`, STRANGER, { checklist_hash: job.checklist_hash })).status).toBe(403);
    await post(`/jobs/${job.id}/accept`, DEMO_CLIENT_ID, { checklist_hash: job.checklist_hash });
    await post(`/jobs/${job.id}/accept`, DEMO_WORKER_ID, { checklist_hash: job.checklist_hash });
    const workerLocks = await post(`/jobs/${job.id}/lock`, DEMO_WORKER_ID);
    expect(workerLocks.status).toBe(403);
    expect(workerLocks.body.error).toMatch(/Only the client/);
    expect((await post(`/jobs/${job.id}/cancel`, DEMO_WORKER_ID)).status).toBe(403);
    await post(`/jobs/${job.id}/lock`, DEMO_CLIENT_ID);
    await post(`/jobs/${job.id}/confirm`, DEMO_CLIENT_ID);
    expect((await post(`/jobs/${job.id}/submit`, DEMO_CLIENT_ID, { deliverable_url: "https://example.com/" })).status).toBe(403);
    expect((await post(`/jobs/${job.id}/settle`, STRANGER)).status).toBe(403);
  });

  it("steps out of order are refused with the allowed next states", async () => {
    const job = await postJob();
    const early = await post(`/jobs/${job.id}/submit`, DEMO_WORKER_ID, { deliverable_url: "https://example.com/" });
    expect(early.status).toBe(409);
    expect(early.body.error).toMatch(/cannot move from CHECKLIST_PROPOSED to DELIVERED/);
    expect((await post(`/jobs/${job.id}/lock`, DEMO_CLIENT_ID)).status).toBe(400);
    expect((await post(`/jobs/job_nope/lock`, DEMO_CLIENT_ID)).status).toBe(404);
  });

  it("cancel works before funding and not after", async () => {
    const a = await postJob();
    expect((await post(`/jobs/${a.id}/cancel`, DEMO_CLIENT_ID, { reason: "changed my mind" })).body.status).toBe("CANCELLED");
    const b = await agreedJob();
    await post(`/jobs/${b.id}/lock`, DEMO_CLIENT_ID);
    await post(`/jobs/${b.id}/confirm`, DEMO_CLIENT_ID);
    expect((await post(`/jobs/${b.id}/cancel`, DEMO_CLIENT_ID)).status).toBe(409);
  });

  it("submit rejects non-http URLs and embedded credentials", async () => {
    const job = await agreedJob();
    await post(`/jobs/${job.id}/lock`, DEMO_CLIENT_ID);
    await post(`/jobs/${job.id}/confirm`, DEMO_CLIENT_ID);
    for (const url of ["file:///etc/passwd", "https://user:pw@example.com/", "not a url"]) {
      expect((await post(`/jobs/${job.id}/submit`, DEMO_WORKER_ID, { deliverable_url: url })).status).toBe(400);
    }
  });
});

describe("money calls", () => {
  it("lock creates the order with the contract hash and is repeatable; confirm stores capture IDs", async () => {
    const job = await agreedJob();
    const lock = await post(`/jobs/${job.id}/lock`, DEMO_CLIENT_ID);
    expect(lock.body).toEqual({ paypal_order_id: "ORDER-1", approve_url: expect.stringMatching(/^https:/) });
    expect((await post(`/jobs/${job.id}/lock`, DEMO_CLIENT_ID)).status).toBe(200);
    const view = (await call("GET", `/jobs/${job.id}`)).body;
    expect(view).toMatchObject({ status: "FUNDING_PENDING", paypal_order_id: "ORDER-1" });

    const conf = await post(`/jobs/${job.id}/confirm`, DEMO_CLIENT_ID);
    expect(conf.body.status).toBe("FUNDED");
    const led = (await call("GET", `/jobs/${job.id}/ledger`)).body;
    expect(led).toMatchObject({ held_cents: 10000, released_cents: 0, refunded_cents: 0, paypal_order_id: "ORDER-1" });
    expect(led.entries.map((e: { payload: { to?: string } }) => e.payload?.to)).toEqual(["FUNDING_PENDING", "FUNDED"]);
  });

  it("a PayPal failure is a 502 and changes nothing", async () => {
    class FailingRail extends MockRail {
      override async lock(): Promise<never> {
        throw new Error("PAYEE_ACCOUNT_RESTRICTED");
      }
    }
    rebuild({ rail: new FailingRail() });
    const job = await agreedJob();
    const res = await post(`/jobs/${job.id}/lock`, DEMO_CLIENT_ID);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/PAYEE_ACCOUNT_RESTRICTED/);
    expect(db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status).toBe("AGREED");
  });

  it("without a rail, money routes answer 503 and say why", async () => {
    rebuild({ rail: undefined });
    const job = await agreedJob();
    const res = await post(`/jobs/${job.id}/lock`, DEMO_CLIENT_ID);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/T2\.3/);
  });
});

describe("verification", () => {
  it("returns 202 and runs in the background; a second request is refused", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fake = async (d: Db, jobId: string): Promise<VerificationSummary> => {
      d.update(jobs).set({ status: "VERIFYING" }).where(eq(jobs.id, jobId)).run();
      await gate;
      return { jobId, round: 1, status: "incomplete", rejected: [], runs: [], injectionItems: [] };
    };
    rebuild({ verify: fake });
    const job = await deliveredJob();
    const res = await post(`/jobs/${job.id}/verify`, DEMO_WORKER_ID);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "VERIFYING", job: `/jobs/${job.id}` });
    expect((await post(`/jobs/${job.id}/verify`, DEMO_CLIENT_ID)).status).toBe(400);
    release();
  });

  it("without a verifier configured, verify answers 503", async () => {
    const job = await deliveredJob();
    expect((await post(`/jobs/${job.id}/verify`, DEMO_CLIENT_ID)).status).toBe(503);
  });
});

describe("the whole lifecycle over HTTP (real verifier quorum, mock PayPal)", () => {
  it("flawed site: agree, lock, confirm, submit, verify, settle — 3 released, 1 refunded, receipt verifies", async () => {
    const config = loadConfig({ MCP_AUTH_TOKEN: SECRET, PUBLIC_BASE_URL: base, PORT: new URL(base).port });
    rebuild({ verify: buildVerifier(config, keyring, store) });

    const job = await deliveredJob("flawed");
    const v = await post(`/jobs/${job.id}/verify?wait=1`, DEMO_CLIENT_ID);
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body.summary.status).toBe("verified");
    expect(v.body.job.verification.runs).toHaveLength(3);

    // Items the quorum left to a person need the client.
    for (const ms of v.body.job.milestones) {
      for (const it of ms.items) {
        if (it.verdict === "needs_client") {
          expect((await post(`/jobs/${job.id}/items/${ms.m}/${it.i}/decision`, DEMO_WORKER_ID, { decision: "approve" })).status).toBe(403);
          expect((await post(`/jobs/${job.id}/items/${ms.m}/${it.i}/decision`, DEMO_CLIENT_ID, { decision: "approve" })).status).toBe(200);
        }
      }
    }
    // A quorum-decided item cannot be overruled by the client.
    const decided = await post(`/jobs/${job.id}/items/0/0/decision`, DEMO_CLIENT_ID, { decision: "reject" });
    expect(decided.status).toBe(409);

    const s = await post(`/jobs/${job.id}/settle`, DEMO_WORKER_ID);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.settlement).toMatchObject({ releasedCents: 7500, refundedCents: 2500 });
    expect(s.body.job.status).toBe("SETTLED");
    expect(s.body.job.milestones.map((m: { status: string }) => m.status)).toEqual(["released", "released", "refunded", "released"]);

    const led = (await call("GET", `/jobs/${job.id}/ledger`)).body;
    expect(led).toMatchObject({ held_cents: 0, released_cents: 7500, refunded_cents: 2500 });
    expect(rail.moved.map((m) => m.kind)).toEqual(["release", "release", "refund", "release"]);

    // Settling again moves nothing.
    expect((await post(`/jobs/${job.id}/settle`, DEMO_CLIENT_ID)).body.settlement.alreadySettled).toBe(true);
    expect(rail.moved).toHaveLength(4);

    const receipt = (await call("GET", `/jobs/${job.id}/receipt`)).body;
    expect(verifyReceipt(receipt, { issuerFingerprint: issuer.public.fingerprint }).ok).toBe(true);

    const mine = (await call("GET", `/jobs?party=${DEMO_WORKER_ID}&status=SETTLED`)).body.jobs;
    expect(mine.map((j: { id: string }) => j.id)).toEqual([job.id]);
    expect((await call("GET", `/jobs?status=NOPE`)).status).toBe(400);
  }, 120_000);
});
