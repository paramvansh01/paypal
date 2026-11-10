import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { clientDecisions, events, jobs, milestones } from "../db/schema.js";
import { QuorumCertificate } from "../qaps/quorum.js";
import { assembleReceipt, type ProofReceipt } from "../qaps/receipt.js";
import { loadChecklist } from "./checklist-store.js";
import { loadProofFromDb } from "./proof-store.js";
import { JobNotFoundError } from "./state.js";

export class ReceiptUnavailableError extends Error {
  constructor(readonly jobId: string) {
    super(`Job ${jobId} has no quorum certificate yet, so there is no Proof Receipt. Run verification first.`);
    this.name = "ReceiptUnavailableError";
  }
}

/**
 * Builds the Proof Receipt for a job from the database (section 6.12).
 * Shared by `GET /jobs/:id/receipt` and the MCP `get_receipt` tool (T4.1).
 * Throws JobNotFoundError or ReceiptUnavailableError.
 */
export function getReceipt(db: Db, jobId: string, opts: { publicBaseUrl: string; now?: () => Date }): ProofReceipt {
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw new JobNotFoundError(jobId);
  const proof = loadProofFromDb(db, jobId);
  const cert = proof && QuorumCertificate.safeParse(proof.certificate);
  if (!proof || !cert?.success) throw new ReceiptUnavailableError(jobId);

  const ms = db.select().from(milestones).where(eq(milestones.jobId, jobId)).orderBy(asc(milestones.position)).all();
  const decisions = db.select().from(clientDecisions).where(eq(clientDecisions.jobId, jobId)).orderBy(asc(clientDecisions.m), asc(clientDecisions.i)).all();
  const timeline = db.select().from(events).where(eq(events.jobId, jobId)).orderBy(asc(events.id)).all();

  return assembleReceipt({
    job: { id: job.id, title: job.title, status: job.status, rail: job.rail, deliverable_url: proof.deliverableUrl },
    contract: loadChecklist(db, jobId),
    certificate: cert.data,
    leaves: proof.leaves,
    clientDecisions: decisions.map((d) => ({ m: d.m, i: d.i, decision: d.decision, actor: d.actor, note: d.note, decided_at: d.createdAt })),
    milestones: ms.map((m) => ({
      title: m.title,
      amount_cents: m.amountCents,
      status: m.status,
      paypal: { capture_id: m.paypalCaptureId, release_id: m.paypalReleaseId, refund_id: m.paypalRefundId },
    })),
    paypalOrderId: job.paypalOrderId,
    events: timeline.map((e) => ({ type: e.type, actor: e.actor, payload: e.payload ?? null, at: e.createdAt })),
    publicBaseUrl: opts.publicBaseUrl,
    issuedAt: (opts.now?.() ?? new Date()).toISOString(),
  });
}
