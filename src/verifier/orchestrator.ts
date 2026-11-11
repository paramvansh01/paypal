import type { Judge } from "../llm/judge.js";
import { EventEmitter } from "node:events";
import { and, asc, eq, max } from "drizzle-orm";
import { contractItems } from "../core/checklist.js";
import { assertChecklistIntact, loadChecklist } from "../core/checklist-store.js";
import { JobNotFoundError, recordEvent, transition } from "../core/state.js";
import type { Db } from "../db/client.js";
import { checklistItems, evidence, jobs, milestones, quorumCertificates, verifierRuns } from "../db/schema.js";
import type { Keyring } from "../qaps/keys.js";
import { leafBytes, type LeafRecord } from "../qaps/leaf.js";
import { leafHash, toHex } from "../qaps/merkle.js";
import {
  buildCertificate,
  certificateHash,
  milestoneOutcomes,
  QuorumNotReachedError,
  type BuildResult,
  type CertificateItem,
  type MilestoneOutcome,
} from "../qaps/quorum.js";
import type { PanelSlot } from "./browser.js";
import type { EvidenceStore } from "./evidence-store.js";
import { runVerifier, type ItemProgress } from "./runner.js";
import type { NetworkPolicy } from "./url-guard.js";

/**
 * TQ.6: the quorum orchestrator. Runs the n verifiers of the contract in
 * parallel, stores every signed report, builds the quorum certificate, writes
 * the final verdicts and moves the job to VERIFIED. If fewer than k verifiers
 * finish, the job goes back to DELIVERED so verification can be retried.
 */

export interface VerifyDeps {
  keyring: Keyring;
  store: EvidenceStore;
  network: NetworkPolicy;
  /** Browser for each verifier slot (see panelBrowsers). */
  panel: (verifierIds: string[], deliverableUrl: string) => PanelSlot[];
  judgeModels: string[];
  /** Builds the AI judge for one model (T3.6). Without it, llm_judgement items go to the client. */
  judgeFor?: (model: string) => Judge | undefined;
  checkTimeoutMs: number;
  /** Live progress for the UI. Emits "item" (ItemProgress & {jobId, round}) and "run" events. */
  bus?: EventEmitter;
  now?: () => Date;
}

export interface RunSummary {
  verifierId: string;
  browser: string;
  status: "done" | "error";
  error?: string;
  replayUrl?: string;
}

export interface VerificationSummary {
  jobId: string;
  round: number;
  status: "verified" | "incomplete";
  certificateHash?: string;
  items?: CertificateItem[];
  outcomes?: MilestoneOutcome[];
  rejected: BuildResult["rejected"];
  runs: RunSummary[];
  injectionItems: { m: number; i: number; flags: number }[];
}

export class VerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationError";
  }
}

export async function verifyJob(db: Db, jobId: string, deps: VerifyDeps): Promise<VerificationSummary> {
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw new JobNotFoundError(jobId);
  if (job.status !== "DELIVERED") throw new VerificationError(`Job ${jobId} is ${job.status}; verification needs DELIVERED.`);
  if (!job.deliverableUrl) throw new VerificationError(`Job ${jobId} has no deliverable URL.`);
  const deliverableUrl = job.deliverableUrl;

  const contractHash = assertChecklistIntact(db, jobId);
  const contract = loadChecklist(db, jobId);
  const ids = contract.quorum.verifiers.map((v) => v.id);
  // This server must hold exactly the keys the contract names; otherwise its signatures would be rejected.
  for (const v of contract.quorum.verifiers) {
    const key = deps.keyring.get(v.id);
    if (!key || key.public.public_key !== v.public_key) {
      throw new VerificationError(`This server cannot sign as ${v.id}: the contract names a different key.`);
    }
  }

  const round = (db.select({ r: max(verifierRuns.round) }).from(verifierRuns).where(eq(verifierRuns.jobId, jobId)).get()?.r ?? 0) + 1;
  transition(db, jobId, "VERIFYING", { actor: "kept", expectedFrom: "DELIVERED", payload: { round, deliverable_url: deliverableUrl } });

  // Map (m, i) → checklist_items.id, for evidence rows.
  const itemIds = new Map<string, string>();
  for (const row of db
    .select({ id: checklistItems.id, i: checklistItems.position, m: milestones.position })
    .from(checklistItems)
    .innerJoin(milestones, eq(checklistItems.milestoneId, milestones.id))
    .where(eq(milestones.jobId, jobId))
    .all()) {
    itemIds.set(`${row.m}.${row.i}`, row.id);
  }

  const slots = deps.panel(ids, deliverableUrl);
  const runs: RunSummary[] = [];
  const results = await Promise.all(
    slots.map(async (slot, idx) => {
      const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
      const judgeModel = deps.judgeModels[idx % deps.judgeModels.length]!;
      db.insert(verifierRuns)
        .values({ id: runId, jobId, round, verifierId: slot.verifierId, browser: slot.provider.kind, judgeModel, deliverableUrl })
        .run();
      deps.bus?.emit("run", { jobId, round, verifierId: slot.verifierId, status: "running" });
      try {
        const res = await runVerifier({
          verifierId: slot.verifierId,
          key: deps.keyring.get(slot.verifierId)!,
          provider: slot.provider,
          fallback: slot.fallback,
          judgeModel,
          judge: deps.judgeFor?.(judgeModel),
          jobId,
          contract,
          contractHash,
          deliverableUrl,
          network: deps.network,
          checkTimeoutMs: deps.checkTimeoutMs,
          store: deps.store,
          now: deps.now,
          onItem: (p: ItemProgress) => {
            recordEvent(db, jobId, "VERIFIER_ITEM", {
              actor: p.verifierId,
              payload: { round, m: p.m, i: p.i, verdict: p.leaf.verdict, injection: p.leaf.injection, summary: p.leaf.summary },
            });
            deps.bus?.emit("item", { jobId, round, ...p });
          },
        });
        const { attestation, leaves } = res.report;
        db.transaction((tx) => {
          tx.update(verifierRuns)
            .set({
              status: "done",
              browser: res.browserLabel,
              merkleRoot: attestation.payload.merkle_root,
              leafCount: attestation.payload.leaf_count,
              attestation: attestation as unknown as Record<string, unknown>,
              replayUrl: res.replayUrl ?? null,
              finishedAt: new Date().toISOString(),
            })
            .where(eq(verifierRuns.id, runId))
            .run();
          leaves.forEach((leaf: LeafRecord, leafIndex) => {
            tx.insert(evidence)
              .values({
                id: `ev_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
                verifierRunId: runId,
                itemId: itemIds.get(`${leaf.m}.${leaf.i}`)!,
                leafIndex,
                leaf: leaf as unknown as Record<string, unknown>,
                leafHash: toHex(leafHash(leafBytes(leaf))),
              })
              .run();
          });
        });
        runs[idx] = { verifierId: slot.verifierId, browser: res.browserLabel, status: "done", replayUrl: res.replayUrl };
        deps.bus?.emit("run", { jobId, round, verifierId: slot.verifierId, status: "done" });
        return res.report;
      } catch (err) {
        const message = err instanceof Error ? err.message.split("\n")[0]! : String(err);
        db.update(verifierRuns).set({ status: "error", error: message, finishedAt: new Date().toISOString() }).where(eq(verifierRuns.id, runId)).run();
        runs[idx] = { verifierId: slot.verifierId, browser: slot.provider.kind, status: "error", error: message };
        deps.bus?.emit("run", { jobId, round, verifierId: slot.verifierId, status: "error", error: message });
        return undefined;
      }
    }),
  );
  const reports = results.filter((r) => r !== undefined);

  let built: BuildResult;
  try {
    built = buildCertificate({
      job_id: jobId,
      contract,
      deliverable_url: deliverableUrl,
      reports,
      issued_at: (deps.now?.() ?? new Date()).toISOString(),
    });
  } catch (err) {
    if (!(err instanceof QuorumNotReachedError)) throw err;
    transition(db, jobId, "DELIVERED", { actor: "kept", expectedFrom: "VERIFYING", payload: { round, reason: err.message } });
    recordEvent(db, jobId, "VERIFICATION_INCOMPLETE", { actor: "kept", payload: { round, reason: err.message, runs } });
    return { jobId, round, status: "incomplete", rejected: err.rejected, runs, injectionItems: [] };
  }

  const { certificate, rejected } = built;
  const certHash = certificateHash(certificate);
  const accepted = reports.filter((r) => certificate.attestations.some((a) => a.payload.verifier_id === r.attestation.payload.verifier_id));
  const injectionItems = contractItems(contract)
    .map(({ m, i }, idx) => ({ m, i, flags: accepted.filter((r) => r.leaves[idx]!.injection).length }))
    .filter((x) => x.flags > 0);

  db.transaction((tx) => {
    tx.insert(quorumCertificates)
      .values({
        id: `qc_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
        jobId,
        round,
        certificate: certificate as unknown as Record<string, unknown>,
        certificateHash: certHash,
      })
      .run();
    for (const item of certificate.items) {
      tx.update(checklistItems).set({ verdict: item.verdict, verdictReason: item.reason }).where(eq(checklistItems.id, itemIds.get(`${item.m}.${item.i}`)!)).run();
    }
  });
  for (const x of injectionItems) {
    recordEvent(db, jobId, x.flags >= contract.quorum.k ? "INJECTION_DETECTED" : "INJECTION_SUSPECTED", {
      actor: "kept",
      payload: { round, m: x.m, i: x.i, flags: x.flags, k: contract.quorum.k, worker_id: job.workerId },
    });
  }
  if (rejected.length) recordEvent(db, jobId, "REPORTS_REJECTED", { actor: "kept", payload: { round, rejected } });
  transition(db, jobId, "VERIFIED", {
    actor: "kept",
    expectedFrom: "VERIFYING",
    payload: { round, certificate_hash: certHash, passed: certificate.items.filter((x) => x.verdict === "pass").length, total: certificate.items.length },
  });

  return {
    jobId,
    round,
    status: "verified",
    certificateHash: certHash,
    items: certificate.items,
    outcomes: milestoneOutcomes(contract, certificate.items),
    rejected,
    runs,
    injectionItems,
  };
}

/** Jobs left in VERIFYING by a crash go back to DELIVERED so they can be verified again. */
export function recoverInterruptedVerifications(db: Db): string[] {
  const stuck = db.select({ id: jobs.id }).from(jobs).where(eq(jobs.status, "VERIFYING")).all();
  for (const { id } of stuck) {
    transition(db, id, "DELIVERED", { actor: "kept", expectedFrom: "VERIFYING", payload: { reason: "verification interrupted (server restart)" } });
  }
  return stuck.map((s) => s.id);
}

/** Leaves of one run, in order, exactly as signed. */
export function leavesOfRun(db: Db, runId: string): LeafRecord[] {
  return db
    .select({ leaf: evidence.leaf })
    .from(evidence)
    .where(eq(evidence.verifierRunId, runId))
    .orderBy(asc(evidence.leafIndex))
    .all()
    .map((r) => r.leaf as unknown as LeafRecord);
}

/** Runs of one round, keyed by verifier ID. */
export function runsOfRound(db: Db, jobId: string, round: number) {
  return db.select().from(verifierRuns).where(and(eq(verifierRuns.jobId, jobId), eq(verifierRuns.round, round))).all();
}
