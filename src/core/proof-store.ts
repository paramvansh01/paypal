import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { clientDecisions, jobs, quorumCertificates } from "../db/schema.js";
import { QuorumCertificate } from "../qaps/quorum.js";
import { leavesOfRun, runsOfRound } from "../verifier/orchestrator.js";
import type { SettlementProof } from "./settlement.js";
import { JobNotFoundError, recordEvent } from "./state.js";

/**
 * Loads what settlement needs to re-verify a job: the latest quorum
 * certificate, the exact leaves each attesting verifier signed, the
 * deliverable URL and the client's decisions.
 */
export function loadProofFromDb(db: Db, jobId: string): SettlementProof | undefined {
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw new JobNotFoundError(jobId);
  const row = db.select().from(quorumCertificates).where(eq(quorumCertificates.jobId, jobId)).orderBy(desc(quorumCertificates.round)).get();
  if (!row || !job.deliverableUrl) return undefined;
  const parsed = QuorumCertificate.safeParse(row.certificate);
  const leaves: SettlementProof["leaves"] = {};
  if (parsed.success) {
    const runs = runsOfRound(db, jobId, row.round);
    for (const att of parsed.data.attestations) {
      const run = runs.find((r) => r.verifierId === att.payload.verifier_id && r.status === "done");
      if (run) leaves[run.verifierId] = leavesOfRun(db, run.id);
    }
  }
  return {
    certificate: row.certificate,
    leaves,
    deliverableUrl: job.deliverableUrl,
    clientDecisions: db
      .select({ m: clientDecisions.m, i: clientDecisions.i, decision: clientDecisions.decision })
      .from(clientDecisions)
      .where(eq(clientDecisions.jobId, jobId))
      .all(),
  };
}

export class DecisionError extends Error {}

/**
 * Records the client's decision on an item the quorum left to a person
 * (client_approval items, or no quorum). Decisions are final.
 */
export function recordClientDecision(
  db: Db,
  args: { jobId: string; m: number; i: number; decision: "approve" | "reject"; actor: string; note?: string },
): void {
  const proof = loadProofFromDb(db, args.jobId);
  const item = (proof?.certificate as { items?: { m: number; i: number; verdict: string }[] } | undefined)?.items?.find(
    (x) => x.m === args.m && x.i === args.i,
  );
  if (!item) throw new DecisionError(`No verified item ${args.m}.${args.i} on job ${args.jobId}.`);
  if (item.verdict !== "needs_client") throw new DecisionError(`Item ${args.m}.${args.i} was decided by the verifier quorum (${item.verdict}).`);
  const existing = db
    .select()
    .from(clientDecisions)
    .where(and(eq(clientDecisions.jobId, args.jobId), eq(clientDecisions.m, args.m), eq(clientDecisions.i, args.i)))
    .get();
  if (existing) throw new DecisionError(`Item ${args.m}.${args.i} was already ${existing.decision}d.`);
  db.insert(clientDecisions)
    .values({ id: `cd_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`, ...args, note: args.note ?? null })
    .run();
  recordEvent(db, args.jobId, args.decision === "approve" ? "ITEM_APPROVED" : "ITEM_REJECTED", {
    actor: args.actor,
    payload: { m: args.m, i: args.i, note: args.note ?? null },
  });
}
