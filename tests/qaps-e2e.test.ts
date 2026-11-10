import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadProofFromDb, recordClientDecision } from "../src/core/proof-store.js";
import { settleJob } from "../src/core/settlement.js";
import { openDb, type Db } from "../src/db/client.js";
import { checklistItems, events, evidence, jobs, verifierRuns } from "../src/db/schema.js";
import { seedDemoParties } from "../src/db/seed.js";
import { createDeliveredDemoJob } from "../src/demo/job.js";
import { loadKeyring, type Keyring } from "../src/qaps/keys.js";
import { verifierIds } from "../src/qaps/protocol.js";
import { createApp } from "../src/server/app.js";
import { panelBrowsers, type BrowserProvider } from "../src/verifier/browser.js";
import { EvidenceStore } from "../src/verifier/evidence-store.js";
import { recoverInterruptedVerifications, verifyJob, VerificationError, type VerifyDeps } from "../src/verifier/orchestrator.js";
import { MockRail } from "./helpers/qaps.js";

let app: Server;
let origin: string;
let db: Db;
const keyring: Keyring = loadKeyring(verifierIds(3), { dir: mkdtempSync(join(tmpdir(), "kept-e2e-keys-")) });
const store = new EvidenceStore(mkdtempSync(join(tmpdir(), "kept-e2e-ev-")));

beforeAll(async () => {
  app = createApp(loadConfig({})).listen(0, "127.0.0.1");
  await new Promise((r) => app.once("listening", r));
  origin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => app.close(r)));

beforeEach(() => {
  db = openDb(":memory:");
  seedDemoParties(db, loadConfig({ DEMO_CLIENT_EMAIL: "c@example.com", DEMO_WORKER_EMAIL: "w@example.com" }));
});

const deps = (over: Partial<VerifyDeps> = {}): VerifyDeps => ({
  keyring,
  store,
  network: { allowOrigins: [origin] },
  panel: (ids, url) => panelBrowsers(ids, { preferKernel: false, deliverableUrl: url }),
  judgeModels: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  checkTimeoutMs: 8000,
  ...over,
});
const site = (name: string) => `${origin}/demo/sites/${name}/`;
const eventTypes = (jobId: string) => db.select().from(events).where(eq(events.jobId, jobId)).all().map((e) => e.type);

describe("the whole proof-carrying payment, end to end (local browsers, mock PayPal)", () => {
  it("good site: 3 verifiers on 2 engines agree on everything, all 4 milestones are paid", async () => {
    const jobId = createDeliveredDemoJob(db, { keyring, deliverableUrl: site("good") });
    const summary = await verifyJob(db, jobId, deps());

    expect(summary.status).toBe("verified");
    expect(summary.runs.map((r) => r.browser)).toEqual([
      expect.stringMatching(/^local-chromium /),
      expect.stringMatching(/^local-chromium /),
      expect.stringMatching(/^local-webkit /),
    ]);
    expect(summary.items!.every((x) => x.verdict === "pass" && x.reason === "quorum")).toBe(true);
    expect(summary.outcomes).toEqual(["passed", "passed", "passed", "passed"]);
    expect(db.select().from(jobs).where(eq(jobs.id, jobId)).get()!.status).toBe("VERIFIED");

    // Every signed artifact is retrievable by its hash.
    for (const row of db.select().from(evidence).all()) {
      const leaf = row.leaf as { artifacts: Record<string, string> };
      if (leaf.artifacts.screenshot_sha256) expect(store.get(leaf.artifacts.screenshot_sha256, "png")).toBeDefined();
      expect(store.get(leaf.artifacts.details_sha256!, "json")).toBeDefined();
    }

    const rail = new MockRail();
    const report = await settleJob(db, jobId, { rail, loadProof: loadProofFromDb, actor: "kept" });
    expect(report).toMatchObject({ releasedCents: 10000, refundedCents: 0 });
    expect(report.certificateHash).toBe(summary.certificateHash);
  }, 120_000);

  it("flawed site: the broken contact form is refunded, the rest is paid", async () => {
    const jobId = createDeliveredDemoJob(db, { keyring, deliverableUrl: site("flawed") });
    const summary = await verifyJob(db, jobId, deps());
    expect(summary.outcomes).toEqual(["passed", "passed", "failed", "passed"]);
    expect(summary.items!.find((x) => x.m === 2)).toEqual({ m: 2, i: 0, verdict: "fail", reason: "quorum" });
    expect(summary.injectionItems).toEqual([]);

    const rail = new MockRail();
    const report = await settleJob(db, jobId, { rail, loadProof: loadProofFromDb, actor: "kept" });
    expect(report.milestones.map((m) => m.action)).toEqual(["released", "released", "refunded", "released"]);
    expect(report).toMatchObject({ releasedCents: 7500, refundedCents: 2500 });
  }, 120_000);

  it("sneaky site: every verifier catches the injection, the item fails for that reason, the worker is flagged", async () => {
    const jobId = createDeliveredDemoJob(db, { keyring, deliverableUrl: site("sneaky") });
    const summary = await verifyJob(db, jobId, deps());
    expect(summary.items!.find((x) => x.m === 2)).toEqual({ m: 2, i: 0, verdict: "fail", reason: "injection" });
    expect(summary.injectionItems).toEqual([{ m: 2, i: 0, flags: 3 }]);
    expect(eventTypes(jobId)).toContain("INJECTION_DETECTED");
    const formItem = db.select().from(checklistItems).where(eq(checklistItems.checkType, "form_submits")).get()!;
    expect(formItem).toMatchObject({ verdict: "fail", verdictReason: "injection" });
    const leaf = db.select().from(evidence).where(eq(evidence.itemId, formItem.id)).get()!.leaf as { summary: string };
    expect(leaf.summary).toMatch(/^Prompt-injection attempt/);

    const report = await settleJob(db, jobId, { rail: new MockRail(), loadProof: loadProofFromDb, actor: "kept" });
    expect(report.milestones[2]!.action).toBe("refunded");
  }, 120_000);

  it("settlement refuses if stored evidence is edited after verification", async () => {
    const jobId = createDeliveredDemoJob(db, { keyring, deliverableUrl: site("flawed") });
    await verifyJob(db, jobId, deps());
    const row = db.select().from(evidence).where(eq(evidence.leafIndex, 6)).get()!;
    db.update(evidence)
      .set({ leaf: { ...(row.leaf as object), verdict: "pass" } })
      .where(eq(evidence.id, row.id))
      .run();
    const rail = new MockRail();
    await expect(settleJob(db, jobId, { rail, loadProof: loadProofFromDb, actor: "kept" })).rejects.toThrow(/evidence does not match the signed Merkle root/);
    expect(rail.calls).toHaveLength(0);
  }, 120_000);

  it("if fewer than k verifiers finish, the job goes back to DELIVERED for a retry", async () => {
    const jobId = createDeliveredDemoJob(db, { keyring, deliverableUrl: site("good") });
    const broken: BrowserProvider = { kind: "local-chromium", open: async () => Promise.reject(new Error("browser crashed")) };
    const summary = await verifyJob(
      db,
      jobId,
      deps({ panel: (ids, url) => panelBrowsers(ids, { preferKernel: false, deliverableUrl: url }).map((s, i) => (i === 0 ? s : { ...s, provider: broken })) }),
    );
    expect(summary.status).toBe("incomplete");
    expect(summary.runs.filter((r) => r.status === "error")).toHaveLength(2);
    expect(db.select().from(jobs).where(eq(jobs.id, jobId)).get()!.status).toBe("DELIVERED");
    expect(db.select().from(verifierRuns).all().map((r) => r.status).sort()).toEqual(["done", "error", "error"]);
    // A second round can still succeed.
    const retry = await verifyJob(db, jobId, deps());
    expect(retry).toMatchObject({ status: "verified", round: 2 });
  }, 120_000);

  it("refuses to verify with keys the contract does not name", async () => {
    const jobId = createDeliveredDemoJob(db, { keyring, deliverableUrl: site("good") });
    const other = loadKeyring(verifierIds(3), { dir: mkdtempSync(join(tmpdir(), "kept-other-")) });
    await expect(verifyJob(db, jobId, deps({ keyring: other }))).rejects.toBeInstanceOf(VerificationError);
    expect(db.select().from(jobs).where(eq(jobs.id, jobId)).get()!.status).toBe("DELIVERED");
  });

  it("recovers jobs stuck in VERIFYING after a crash", () => {
    const jobId = createDeliveredDemoJob(db, { keyring, deliverableUrl: site("good") });
    db.update(jobs).set({ status: "VERIFYING" }).where(eq(jobs.id, jobId)).run();
    expect(recoverInterruptedVerifications(db)).toEqual([jobId]);
    expect(db.select().from(jobs).where(eq(jobs.id, jobId)).get()!.status).toBe("DELIVERED");
  });
});

describe("client decisions", () => {
  it("only items the quorum left to a person can be decided, once", async () => {
    // A contract whose form item gets no quorum is hard to produce with real browsers, so use the
    // flawed site and check the rules on decided items.
    const jobId = createDeliveredDemoJob(db, { keyring, deliverableUrl: site("flawed") });
    await verifyJob(db, jobId, deps());
    expect(() => recordClientDecision(db, { jobId, m: 2, i: 0, decision: "approve", actor: "client" })).toThrow(/decided by the verifier quorum/);
    expect(() => recordClientDecision(db, { jobId, m: 9, i: 0, decision: "approve", actor: "client" })).toThrow(/No verified item/);
  }, 120_000);
});
