import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { events, jobs, milestones, parties } from "../db/schema.js";
import { paypalRequestId } from "../paypal/client.js";
import type { LeafRecord } from "../qaps/leaf.js";
import {
  certificateHash,
  milestoneOutcomes,
  QuorumCertificate,
  validateCertificate,
  type ClientDecision,
  type MilestoneOutcome,
} from "../qaps/quorum.js";
import type { PaymentRail, RailJob, RailMilestone } from "../rails/types.js";
import { assertChecklistIntact, loadChecklist } from "./checklist-store.js";
import { JobNotFoundError, recordEvent, transition } from "./state.js";

/**
 * QAPS part 5: settlement that verifies, not trusts.
 *
 * Before any money moves, settleJob re-checks the contract fingerprint and
 * validates the quorum certificate from scratch. Then it releases passed
 * milestones and refunds failed ones, one PayPal call per milestone, each with
 * a deterministic PayPal-Request-Id. Running it twice, concurrently, or again
 * after a crash never moves money twice: finished milestones are skipped, and
 * a repeated call for an unfinished one reuses the same request ID.
 */

/** Everything settlement needs to re-verify the verdicts. Loaded from the DB in production (TQ.6). */
export interface SettlementProof {
  certificate: unknown;
  /** Leaves per verifier ID. */
  leaves: Record<string, LeafRecord[]>;
  deliverableUrl: string;
  clientDecisions: ClientDecision[];
}
export type ProofLoader = (db: Db, jobId: string) => SettlementProof | undefined;

export interface SettleDeps {
  rail: PaymentRail;
  loadProof: ProofLoader;
  actor: string;
}

export interface MilestoneSettlement {
  id: string;
  position: number;
  title: string;
  amountCents: number;
  action: "released" | "refunded";
  paypalId: string | null;
  /** True when this milestone was already settled before this call. */
  skipped: boolean;
}

export interface SettlementReport {
  jobId: string;
  alreadySettled: boolean;
  certificateHash: string;
  milestones: MilestoneSettlement[];
  releasedCents: number;
  refundedCents: number;
}

export class SettlementError extends Error {
  constructor(
    message: string,
    readonly code: "WRONG_STATUS" | "NO_PROOF" | "PROOF_REJECTED" | "AWAITING_CLIENT",
  ) {
    super(message);
    this.name = "SettlementError";
  }
}

const inFlight = new Map<string, Promise<SettlementReport>>();

/** Settles a VERIFIED job. Calls for the same job are queued, never run in parallel. */
export function settleJob(db: Db, jobId: string, deps: SettleDeps): Promise<SettlementReport> {
  const previous = inFlight.get(jobId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => doSettle(db, jobId, deps));
  inFlight.set(jobId, run);
  const cleanup = () => {
    if (inFlight.get(jobId) === run) inFlight.delete(jobId);
  };
  run.then(cleanup, cleanup);
  return run;
}

async function doSettle(db: Db, jobId: string, deps: SettleDeps): Promise<SettlementReport> {
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw new JobNotFoundError(jobId);
  if (job.status === "SETTLED") return settledReport(db, jobId);
  if (job.status !== "VERIFIED") {
    throw new SettlementError(`Job ${jobId} is ${job.status}; settlement needs VERIFIED.`, "WRONG_STATUS");
  }

  // 1. The contract must still be exactly what both parties agreed.
  const contractHash = assertChecklistIntact(db, jobId);
  const contract = loadChecklist(db, jobId);

  // 2. The verdicts must follow from signed evidence, re-checked from scratch.
  const proof = deps.loadProof(db, jobId);
  if (!proof) throw new SettlementError(`Job ${jobId} has no quorum certificate.`, "NO_PROOF");
  const validation = validateCertificate({
    certificate: proof.certificate,
    contract,
    leaves: proof.leaves,
    expected: { job_id: jobId, contract_hash: contractHash, deliverable_url: proof.deliverableUrl },
  });
  if (!validation.ok) {
    recordEvent(db, jobId, "SETTLEMENT_REFUSED", { actor: deps.actor, payload: { reason: validation.reason } });
    throw new SettlementError(`Certificate rejected: ${validation.reason}`, "PROOF_REJECTED");
  }
  const certHash = certificateHash(QuorumCertificate.parse(proof.certificate));

  // 3. Every milestone needs a final outcome (client decisions included).
  const outcomes = milestoneOutcomes(contract, validation.value, proof.clientDecisions);
  const waiting = outcomes.flatMap((o, m) => (o === "pending" ? [m] : []));
  if (waiting.length) {
    throw new SettlementError(
      `Waiting for the client to decide items in milestone(s) ${waiting.map((m) => m + 1).join(", ")}.`,
      "AWAITING_CLIENT",
    );
  }

  // 4. Move the money, one milestone at a time.
  const rows = db.select().from(milestones).where(eq(milestones.jobId, jobId)).orderBy(asc(milestones.position)).all();
  const railJob = buildRailJob(db, jobId);
  recordEvent(db, jobId, "SETTLEMENT_STARTED", { actor: deps.actor, payload: { certificate_hash: certHash } });

  for (const row of rows) {
    if (row.status === "released" || row.status === "refunded") continue;
    const outcome = outcomes[row.position] as Exclude<MilestoneOutcome, "pending">;
    if (row.status === "pending") {
      db.update(milestones).set({ status: outcome }).where(eq(milestones.id, row.id)).run();
    } else if (row.status !== outcome) {
      // An interrupted run decided differently; never guess which one is right.
      throw new SettlementError(
        `Milestone ${row.position + 1} was marked ${row.status} by an earlier run but the certificate now says ${outcome}.`,
        "PROOF_REJECTED",
      );
    }
    const action = outcome === "passed" ? "release" : "refund";
    const railMs = railJob.milestones.find((m) => m.id === row.id)!;
    const ctx = { requestId: paypalRequestId(jobId, row.id, action), certificateHash: certHash };
    let paypalId: string | null;
    try {
      ({ paypalId } =
        action === "release" ? await deps.rail.releaseMilestone(railJob, railMs, ctx) : await deps.rail.refundMilestone(railJob, railMs, ctx));
    } catch (err) {
      recordEvent(db, jobId, "SETTLEMENT_INTERRUPTED", {
        actor: deps.actor,
        payload: { milestone_id: row.id, action, error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
    db.transaction((tx) => {
      tx.update(milestones)
        .set(action === "release" ? { status: "released", paypalReleaseId: paypalId } : { status: "refunded", paypalRefundId: paypalId })
        .where(eq(milestones.id, row.id))
        .run();
      tx.insert(events)
        .values({
          jobId,
          type: action === "release" ? "MILESTONE_RELEASED" : "MILESTONE_REFUNDED",
          actor: deps.actor,
          payload: {
            milestone_id: row.id,
            position: row.position,
            amount_cents: row.amountCents,
            paypal_id: paypalId,
            request_id: ctx.requestId,
            certificate_hash: certHash,
          },
        })
        .run();
    });
  }

  if (deps.rail.finalize) {
    const ctx = { requestId: paypalRequestId(jobId, null, "finalize"), certificateHash: certHash };
    const { paypalId } = await deps.rail.finalize(railJob, ctx);
    recordEvent(db, jobId, "RAIL_FINALIZED", { actor: deps.actor, payload: { paypal_id: paypalId, request_id: ctx.requestId } });
  }

  const report = settledReport(db, jobId, certHash, false);
  transition(db, jobId, "SETTLED", {
    actor: deps.actor,
    expectedFrom: "VERIFIED",
    payload: { certificate_hash: certHash, released_cents: report.releasedCents, refunded_cents: report.refundedCents },
  });
  return report;
}

function settledReport(db: Db, jobId: string, certHash?: string, alreadySettled = true): SettlementReport {
  const rows = db.select().from(milestones).where(eq(milestones.jobId, jobId)).orderBy(asc(milestones.position)).all();
  const hash =
    certHash ??
    String(
      (db.select().from(events).where(eq(events.jobId, jobId)).all().findLast((e) => e.type === "STATUS_CHANGED" && e.payload?.to === "SETTLED")
        ?.payload?.certificate_hash) ?? "",
    );
  const ms: MilestoneSettlement[] = rows.map((r) => ({
    id: r.id,
    position: r.position,
    title: r.title,
    amountCents: r.amountCents,
    action: r.status === "released" ? "released" : "refunded",
    paypalId: r.status === "released" ? r.paypalReleaseId : r.paypalRefundId,
    skipped: alreadySettled,
  }));
  const sum = (a: MilestoneSettlement["action"]) => ms.filter((m) => m.action === a).reduce((s, m) => s + m.amountCents, 0);
  return { jobId, alreadySettled, certificateHash: hash, milestones: ms, releasedCents: sum("released"), refundedCents: sum("refunded") };
}

export function buildRailJob(db: Db, jobId: string): RailJob {
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw new JobNotFoundError(jobId);
  const worker = job.workerId ? db.select().from(parties).where(eq(parties.id, job.workerId)).get() : undefined;
  const ms: RailMilestone[] = db
    .select()
    .from(milestones)
    .where(eq(milestones.jobId, jobId))
    .orderBy(asc(milestones.position))
    .all()
    .map((m) => ({ id: m.id, position: m.position, title: m.title, amountCents: m.amountCents, paypalCaptureId: m.paypalCaptureId }));
  return {
    id: job.id,
    currency: job.currency,
    totalCents: job.totalAmountCents,
    contractHash: job.checklistHash ?? "",
    paypalOrderId: job.paypalOrderId,
    workerMerchantId: worker?.paypalMerchantId ?? null,
    milestones: ms,
  };
}
