import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { agreeChecklist, ChecklistTamperedError, saveChecklist } from "../src/core/checklist-store.js";
import { settleJob, SettlementError, type SettlementProof } from "../src/core/settlement.js";
import { transition } from "../src/core/state.js";
import { openDb, type Db } from "../src/db/client.js";
import { checklistItems, events, jobs, milestones } from "../src/db/schema.js";
import { DEMO_CLIENT_ID, DEMO_WORKER_ID, seedDemoParties } from "../src/db/seed.js";
import { buildCertificate, type ClientDecision, type VerifierReport } from "../src/qaps/quorum.js";
import { DELIVERABLE, FLAWED_VOTES, ISSUED, JOB, leavesByVerifier, MockRail, qapsFixture } from "./helpers/qaps.js";

const fx = qapsFixture();
let db: Db;

/** Creates the job, agrees the contract and walks it to VERIFIED. */
function verifiedJob(): void {
  db.insert(jobs)
    .values({
      id: JOB,
      title: "Acme site",
      brief: "b",
      clientId: DEMO_CLIENT_ID,
      workerId: DEMO_WORKER_ID,
      totalAmountCents: 1,
      rail: "auth_capture",
    })
    .run();
  saveChecklist(db, JOB, fx.contractInput());
  transition(db, JOB, "CHECKLIST_PROPOSED", { actor: "ai" });
  agreeChecklist(db, JOB, "both");
  for (const s of ["FUNDING_PENDING", "FUNDED", "DELIVERED", "VERIFYING", "VERIFIED"] as const) transition(db, JOB, s, { actor: "t" });
}

function proofFor(reports: VerifierReport[], decisions: ClientDecision[] = [{ m: 2, i: 0, decision: "approve" }]): SettlementProof {
  const { certificate } = buildCertificate({ job_id: JOB, contract: fx.contractInput(), deliverable_url: DELIVERABLE, reports, issued_at: ISSUED });
  return { certificate, leaves: leavesByVerifier(reports), deliverableUrl: DELIVERABLE, clientDecisions: decisions };
}

const flawedReports = () => [fx.report(fx.A, FLAWED_VOTES), fx.report(fx.B, FLAWED_VOTES), fx.report(fx.C, FLAWED_VOTES)];
const msRows = () => db.select().from(milestones).where(eq(milestones.jobId, JOB)).orderBy(asc(milestones.position)).all();
const status = () => db.select().from(jobs).where(eq(jobs.id, JOB)).get()!.status;
const eventTypes = () => db.select().from(events).where(eq(events.jobId, JOB)).all().map((e) => e.type);

beforeEach(() => {
  db = openDb(":memory:");
  seedDemoParties(db, loadConfig({ DEMO_CLIENT_EMAIL: "c@example.com", DEMO_WORKER_EMAIL: "w@example.com", DEMO_WORKER_MERCHANT_ID: "MERCH1" }));
  verifiedJob();
});

describe("settleJob", () => {
  it("releases passed milestones and refunds failed ones", async () => {
    const rail = new MockRail();
    const proof = proofFor(flawedReports());
    const report = await settleJob(db, JOB, { rail, loadProof: () => proof, actor: "kept" });

    expect(report.milestones.map((m) => m.action)).toEqual(["released", "refunded", "released"]);
    expect(report).toMatchObject({ releasedCents: 6000, refundedCents: 3000, alreadySettled: false });
    expect(report.certificateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rail.moved.map((m) => m.kind)).toEqual(["release", "refund", "release"]);
    expect(msRows().map((m) => m.status)).toEqual(["released", "refunded", "released"]);
    expect(msRows()[0]!.paypalReleaseId).toBe("PP-RELEASE-1");
    expect(msRows()[1]!.paypalRefundId).toBe("PP-REFUND-2");
    expect(status()).toBe("SETTLED");
    // Each PayPal call carries the certificate that justified it, and a deterministic request ID.
    expect(new Set(rail.calls.map((c) => c.certificateHash))).toEqual(new Set([report.certificateHash]));
    expect(rail.calls[0]!.requestId).toBe(`kept:${JOB}:${msRows()[0]!.id}:release`);
    expect(eventTypes().filter((t) => t.startsWith("MILESTONE_"))).toEqual(["MILESTONE_RELEASED", "MILESTONE_REFUNDED", "MILESTONE_RELEASED"]);
  });

  it("running settle again moves no money", async () => {
    const rail = new MockRail();
    const proof = proofFor(flawedReports());
    const first = await settleJob(db, JOB, { rail, loadProof: () => proof, actor: "kept" });
    const second = await settleJob(db, JOB, { rail, loadProof: () => proof, actor: "kept" });
    expect(rail.calls).toHaveLength(3);
    expect(second.alreadySettled).toBe(true);
    expect(second.certificateHash).toBe(first.certificateHash);
    expect(second.releasedCents).toBe(6000);
  });

  it("concurrent settle calls are queued and move each milestone once", async () => {
    const rail = new MockRail({ delayMs: 5 });
    const proof = proofFor(flawedReports());
    const deps = { rail, loadProof: () => proof, actor: "kept" };
    const results = await Promise.all([settleJob(db, JOB, deps), settleJob(db, JOB, deps), settleJob(db, JOB, deps)]);
    expect(rail.calls).toHaveLength(3);
    expect(rail.moved).toHaveLength(3);
    expect(results.filter((r) => !r.alreadySettled)).toHaveLength(1);
  });

  it("resumes safely after a crash mid-settlement", async () => {
    const proof = proofFor(flawedReports());
    const rail = new MockRail({ failOn: 2 });
    await expect(settleJob(db, JOB, { rail, loadProof: () => proof, actor: "kept" })).rejects.toThrow(/simulated PayPal outage/);
    expect(status()).toBe("VERIFIED");
    expect(msRows().map((m) => m.status)).toEqual(["released", "failed", "pending"]);
    expect(eventTypes()).toContain("SETTLEMENT_INTERRUPTED");

    const report = await settleJob(db, JOB, { rail, loadProof: () => proof, actor: "kept" });
    expect(status()).toBe("SETTLED");
    expect(report.milestones.map((m) => m.action)).toEqual(["released", "refunded", "released"]);
    // Milestone 1 was released once and never retried; milestone 2's retry reused its request ID.
    expect(rail.moved.map((m) => m.kind)).toEqual(["release", "refund", "release"]);
    const refundCalls = rail.calls.filter((c) => c.kind === "refund");
    expect(refundCalls).toHaveLength(2);
    expect(refundCalls[0]!.requestId).toBe(refundCalls[1]!.requestId);
  });

  it("a retry after PayPal succeeded but before we recorded it does not pay twice", async () => {
    // Simulate: PayPal processed the release, then our process died before writing the DB.
    const proof = proofFor(flawedReports());
    const rail = new MockRail();
    const firstMs = msRows()[0]!;
    await rail.releaseMilestone({} as never, { ...firstMs, paypalCaptureId: null }, {
      requestId: `kept:${JOB}:${firstMs.id}:release`,
      certificateHash: "x",
    });
    await settleJob(db, JOB, { rail, loadProof: () => proof, actor: "kept" });
    expect(rail.moved.filter((m) => m.milestoneId === firstMs.id)).toHaveLength(1);
  });

  it("calls finalize once, with its own request ID", async () => {
    const rail = new MockRail({ withFinalize: true });
    await settleJob(db, JOB, { rail, loadProof: () => proofFor(flawedReports()), actor: "kept" });
    const fin = rail.calls.filter((c) => c.kind === "finalize");
    expect(fin).toEqual([expect.objectContaining({ requestId: `kept:${JOB}:job:finalize` })]);
    expect(eventTypes()).toContain("RAIL_FINALIZED");
  });

  describe("refuses before any money moves", () => {
    const expectRefused = async (proof: SettlementProof | undefined, code: string | RegExp) => {
      const rail = new MockRail();
      const err = await settleJob(db, JOB, { rail, loadProof: () => proof, actor: "kept" }).catch((e) => e);
      if (typeof code === "string") expect(err).toMatchObject({ name: "SettlementError", code });
      else expect(String(err.message)).toMatch(code);
      expect(rail.calls).toHaveLength(0);
      expect(status()).toBe("VERIFIED");
      return err;
    };

    it("while the client has not decided an approval item", async () => {
      const err = await expectRefused(proofFor(flawedReports(), []), "AWAITING_CLIENT");
      expect(err.message).toMatch(/milestone\(s\) 3/);
    });

    it("without a certificate", async () => {
      await expectRefused(undefined, "NO_PROOF");
    });

    it("when a verdict in the certificate was forged", async () => {
      const proof = proofFor(flawedReports());
      (proof.certificate as { items: { verdict: string }[] }).items[2]!.verdict = "pass";
      await expectRefused(proof, "PROOF_REJECTED");
      expect(eventTypes()).toContain("SETTLEMENT_REFUSED");
    });

    it("when evidence was edited after signing", async () => {
      const proof = proofFor(flawedReports());
      proof.leaves["verifier-a"]![2]!.verdict = "pass";
      await expectRefused(proof, "PROOF_REJECTED");
    });

    it("when the certificate is for another deliverable", async () => {
      const proof = { ...proofFor(flawedReports()), deliverableUrl: "https://other.example/" };
      await expectRefused(proof, "PROOF_REJECTED");
    });

    it("when the stored contract was changed after agreement", async () => {
      const item = db.select().from(checklistItems).where(eq(checklistItems.checkType, "text_present")).get()!;
      db.update(checklistItems).set({ params: { path: "/", text: "Other" } }).where(eq(checklistItems.id, item.id)).run();
      const rail = new MockRail();
      await expect(settleJob(db, JOB, { rail, loadProof: () => proofFor(flawedReports()), actor: "kept" })).rejects.toThrow(
        ChecklistTamperedError,
      );
      expect(rail.calls).toHaveLength(0);
    });

    it("when the job is not VERIFIED", async () => {
      transition(db, JOB, "DISPUTED", { actor: "client" });
      const rail = new MockRail();
      await expect(settleJob(db, JOB, { rail, loadProof: () => proofFor(flawedReports()), actor: "kept" })).rejects.toBeInstanceOf(
        SettlementError,
      );
      expect(rail.calls).toHaveLength(0);
    });
  });

  it("a rejected client approval refunds that milestone", async () => {
    const rail = new MockRail();
    const report = await settleJob(db, JOB, {
      rail,
      loadProof: () => proofFor(flawedReports(), [{ m: 2, i: 0, decision: "reject" }]),
      actor: "kept",
    });
    expect(report.milestones.map((m) => m.action)).toEqual(["released", "refunded", "refunded"]);
    expect(report).toMatchObject({ releasedCents: 3000, refundedCents: 6000 });
  });
});

describe("settleJob consistency guard", () => {
  it("refuses if an interrupted run recorded a different outcome", async () => {
    const proof = proofFor(flawedReports());
    await settleJob(db, JOB, { rail: new MockRail({ failOn: 1 }), loadProof: () => proof, actor: "kept" }).catch(() => undefined);
    expect(msRows()[0]!.status).toBe("passed");
    db.update(milestones).set({ status: "failed" }).where(eq(milestones.id, msRows()[0]!.id)).run();
    const rail = new MockRail();
    await expect(settleJob(db, JOB, { rail, loadProof: () => proof, actor: "kept" })).rejects.toThrow(/marked failed by an earlier run/);
    expect(rail.calls).toHaveLength(0);
  });
});
