import { and, asc, desc, eq, inArray, max, or } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import {
  checklistItems,
  clientDecisions,
  events,
  JOB_STATUSES,
  jobs,
  milestones,
  parties,
  quorumCertificates,
  verifierRuns,
  type JobStatus,
} from "../db/schema.js";
import { paypalRequestId } from "../paypal/client.js";
import type { Keyring } from "../qaps/keys.js";
import { milestoneOutcomes, QuorumCertificate, type MilestoneOutcome } from "../qaps/quorum.js";
import type { PaymentRail, RailJob, RailName } from "../rails/types.js";
import { agreeChecklist, loadChecklist, saveChecklist } from "./checklist-store.js";
import { canonicalJson, checklistHash, parseChecklist, type Checklist } from "./checklist.js";
import { JobNotFoundError, recordEvent, transition } from "./state.js";

/**
 * T2.6: the job lifecycle as plain functions, shared by the REST API and the
 * MCP server (T4.1). Each function checks *who* may do it; the state machine
 * (state.ts) checks *when*. Money moves only through the PaymentRail.
 */

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}
export class JobInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobInputError";
  }
}
/** PayPal (or the rail) failed; nothing in our state changed. */
export class RailError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RailError";
  }
}

export interface Party {
  id: string;
  kind: "human" | "agent";
  displayName: string;
}

export function getParty(db: Db, id: string): Party | undefined {
  const p = db.select().from(parties).where(eq(parties.id, id)).get();
  return p && { id: p.id, kind: p.kind, displayName: p.displayName };
}

type JobRow = typeof jobs.$inferSelect;

function loadJob(db: Db, jobId: string): JobRow {
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw new JobNotFoundError(jobId);
  return job;
}

function role(job: JobRow, party: Party): "client" | "worker" | undefined {
  if (job.clientId === party.id) return "client";
  if (job.workerId === party.id) return "worker";
  return undefined;
}

function requireRole(job: JobRow, party: Party, allowed: readonly ("client" | "worker")[], action: string): "client" | "worker" {
  const r = role(job, party);
  if (!r || !allowed.includes(r)) {
    throw new ForbiddenError(`Only the ${allowed.join(" or ")} of job ${job.id} can ${action}.`);
  }
  return r;
}

/** The verifier panel this server runs: its keys, in ID order, with the configured threshold. */
export function serverQuorum(keyring: Keyring, k: number): Checklist["quorum"] {
  const verifiers = [...keyring.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map((key) => ({ id: key.id, public_key: key.public.public_key }));
  return { n: verifiers.length, k, verifiers };
}

function withQuorum(draft: unknown, quorum: Checklist["quorum"]): Checklist {
  if (draft === null || typeof draft !== "object" || Array.isArray(draft)) throw new JobInputError("checklist must be an object");
  if ("quorum" in draft) throw new JobInputError("checklist must not contain `quorum`: this server sets its own verifier panel");
  return parseChecklist({ ...(draft as object), quorum });
}

const newJobId = () => `job_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

export const CreateJobInput = z.strictObject({
  title: z.string().trim().min(1).max(200),
  brief: z.string().trim().min(1).max(5000),
  worker_id: z.string().min(1),
  budget_cents: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
  /** Optional: a checklist without `quorum`. Without one the job stays DRAFT until a checklist is proposed. */
  checklist: z.unknown().optional(),
});

/** The client posts a job. */
export function createJob(
  db: Db,
  client: Party,
  input: z.input<typeof CreateJobInput>,
  opts: { rail: RailName; quorum: Checklist["quorum"] },
): string {
  const data = CreateJobInput.parse(input);
  if (data.worker_id === client.id) throw new JobInputError("worker_id must be a different party from the client");
  if (!getParty(db, data.worker_id)) throw new JobInputError(`unknown worker ${data.worker_id}`);
  const checklist = data.checklist === undefined ? undefined : withQuorum(data.checklist, opts.quorum);
  if (checklist && (checklist.total_cents !== data.budget_cents || checklist.currency !== data.currency)) {
    throw new JobInputError(`checklist total ${checklist.total_cents} ${checklist.currency} does not match the budget ${data.budget_cents} ${data.currency}`);
  }
  const id = newJobId();
  db.insert(jobs)
    .values({
      id,
      title: data.title,
      brief: data.brief,
      clientId: client.id,
      workerId: data.worker_id,
      currency: data.currency,
      totalAmountCents: data.budget_cents,
      rail: opts.rail,
    })
    .run();
  recordEvent(db, id, "JOB_POSTED", { actor: client.id, payload: { worker_id: data.worker_id, budget_cents: data.budget_cents } });
  if (checklist) proposeChecklist(db, id, client, checklist, opts.quorum);
  return id;
}

/** Either party proposes (or replaces) the checklist while it is not yet agreed. Earlier acceptances lapse unless the hash is identical. */
export function proposeChecklist(db: Db, jobId: string, party: Party, draft: unknown, quorum: Checklist["quorum"]): string {
  const job = loadJob(db, jobId);
  requireRole(job, party, ["client", "worker"], "propose a checklist");
  const checklist =
    draft !== null && typeof draft === "object" && "quorum" in (draft as object) && canonicalQuorumMatches((draft as { quorum: unknown }).quorum, quorum)
      ? parseChecklist(draft)
      : withQuorum(draft, quorum);
  if (checklist.total_cents !== job.totalAmountCents || checklist.currency !== job.currency) {
    throw new JobInputError(`checklist total ${checklist.total_cents} ${checklist.currency} does not match the budget ${job.totalAmountCents} ${job.currency}`);
  }
  saveChecklist(db, jobId, checklist);
  const hash = checklistHash(checklist);
  if (job.status === "DRAFT") transition(db, jobId, "CHECKLIST_PROPOSED", { actor: party.id, expectedFrom: "DRAFT", payload: { checklist_hash: hash } });
  else recordEvent(db, jobId, "CHECKLIST_REVISED", { actor: party.id, payload: { checklist_hash: hash } });
  return hash;
}

/** Re-proposing a stored checklist (which already carries our quorum) is allowed only with our exact panel. */
function canonicalQuorumMatches(given: unknown, ours: Checklist["quorum"]): boolean {
  return canonicalJson(given) === canonicalJson(ours);
}

function currentHash(db: Db, job: JobRow): string | undefined {
  if (job.status === "DRAFT") return undefined;
  return job.checklistHash ?? checklistHash(loadChecklist(db, job.id));
}

/** Who has accepted exactly the current checklist. */
export function acceptances(db: Db, job: JobRow): { client: boolean; worker: boolean } {
  const hash = currentHash(db, job);
  if (!hash) return { client: false, worker: false };
  if (job.checklistHash) return { client: true, worker: true };
  const accepted = db
    .select()
    .from(events)
    .where(and(eq(events.jobId, job.id), eq(events.type, "CHECKLIST_ACCEPTED")))
    .all()
    .filter((e) => e.payload?.checklist_hash === hash)
    .map((e) => e.actor);
  return { client: accepted.includes(job.clientId), worker: job.workerId !== null && accepted.includes(job.workerId) };
}

/**
 * A party accepts the checklist with the hash it reviewed. Accepting a stale
 * hash fails, so nobody can accept one version and have another frozen.
 * When both have accepted the current hash, it is frozen (AGREED).
 */
export function acceptChecklist(db: Db, jobId: string, party: Party, reviewedHash: string): { checklist_hash: string; agreed: boolean } {
  const job = loadJob(db, jobId);
  requireRole(job, party, ["client", "worker"], "accept the checklist");
  if (job.status !== "CHECKLIST_PROPOSED") throw new JobInputError(`job ${jobId} is ${job.status}; there is no checklist proposal to accept`);
  const hash = currentHash(db, job)!;
  if (reviewedHash !== hash) throw new JobInputError(`the checklist changed: you reviewed ${reviewedHash}, the current one is ${hash}`);
  recordEvent(db, jobId, "CHECKLIST_ACCEPTED", { actor: party.id, payload: { checklist_hash: hash } });
  const both = acceptances(db, job);
  if (both.client && both.worker) {
    agreeChecklist(db, jobId, party.id);
    return { checklist_hash: hash, agreed: true };
  }
  return { checklist_hash: hash, agreed: false };
}

/** The client cancels before any money is held. */
export function cancelJob(db: Db, jobId: string, party: Party, reason?: string): void {
  const job = loadJob(db, jobId);
  requireRole(job, party, ["client"], "cancel it");
  transition(db, jobId, "CANCELLED", { actor: party.id, payload: { reason: reason ?? null } });
}

async function railCall<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new RailError(`PayPal ${what} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

/** The client locks funds: creates the PayPal order (custom_id = contract hash) and gets the approval link. Repeatable. */
export async function lockFunds(db: Db, jobId: string, party: Party, rail: PaymentRail, buildRailJob: (db: Db, id: string) => RailJob) {
  const job = loadJob(db, jobId);
  requireRole(job, party, ["client"], "lock funds");
  if (job.status !== "AGREED" && job.status !== "FUNDING_PENDING") {
    throw new JobInputError(`job ${jobId} is ${job.status}; funds can be locked once the checklist is AGREED`);
  }
  const res = await railCall("order creation", () => rail.lock(buildRailJob(db, jobId), { requestId: paypalRequestId(jobId, null, "lock") }));
  if (job.status === "AGREED") {
    transition(db, jobId, "FUNDING_PENDING", {
      actor: party.id,
      expectedFrom: "AGREED",
      set: { paypalOrderId: res.orderId },
      payload: { paypal_order_id: res.orderId, contract_hash: job.checklistHash },
    });
  }
  return { paypal_order_id: res.orderId, approve_url: res.approveUrl };
}

/** After the client approved in PayPal: capture or authorize, then FUNDED. */
export async function confirmFunds(db: Db, jobId: string, party: Party, rail: PaymentRail, buildRailJob: (db: Db, id: string) => RailJob) {
  const job = loadJob(db, jobId);
  requireRole(job, party, ["client"], "confirm the payment");
  if (job.status !== "FUNDING_PENDING") throw new JobInputError(`job ${jobId} is ${job.status}; confirm comes after lock`);
  const res = await railCall("capture/authorization", () => rail.confirmLocked(buildRailJob(db, jobId), { requestId: paypalRequestId(jobId, null, "confirm") }));
  const ms = db.select().from(milestones).where(eq(milestones.jobId, jobId)).orderBy(asc(milestones.position)).all();
  db.transaction((tx) => {
    // One capture per milestone (one purchase unit each), or one capture for all of them.
    if (res.captureIds.length === ms.length || res.captureIds.length === 1) {
      ms.forEach((m, idx) => {
        tx.update(milestones).set({ paypalCaptureId: res.captureIds[res.captureIds.length === 1 ? 0 : idx]! }).where(eq(milestones.id, m.id)).run();
      });
    }
  });
  transition(db, jobId, "FUNDED", {
    actor: party.id,
    expectedFrom: "FUNDING_PENDING",
    payload: { capture_ids: res.captureIds, authorization_id: res.authorizationId ?? null },
  });
  return { status: "FUNDED" as const, capture_ids: res.captureIds, authorization_id: res.authorizationId ?? null };
}

/** The worker submits the deliverable URL. */
export function submitWork(db: Db, jobId: string, party: Party, deliverableUrl: string): void {
  const job = loadJob(db, jobId);
  requireRole(job, party, ["worker"], "submit work");
  const url = checkDeliverableUrl(deliverableUrl);
  transition(db, jobId, "DELIVERED", {
    actor: party.id,
    expectedFrom: "FUNDED",
    set: { deliverableUrl: url },
    payload: { deliverable_url: url },
  });
}

function checkDeliverableUrl(deliverableUrl: string): string {
  let url: URL;
  try {
    url = new URL(deliverableUrl);
  } catch {
    throw new JobInputError("deliverable_url is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new JobInputError("deliverable_url must be http(s)");
  if (url.username || url.password) throw new JobInputError("deliverable_url must not contain credentials");
  return url.href;
}

/** Either party may start verification (the verifiers are neutral; who asks does not matter). */
export function assertCanVerify(db: Db, jobId: string, party: Party): void {
  const job = loadJob(db, jobId);
  requireRole(job, party, ["client", "worker"], "start verification");
  if (job.status !== "DELIVERED") throw new JobInputError(`job ${jobId} is ${job.status}; verification needs DELIVERED`);
}

export const DecisionInput = z.strictObject({
  decision: z.enum(["approve", "reject"]),
  note: z.string().max(2000).optional(),
});

export function assertClient(db: Db, jobId: string, party: Party, action: string): void {
  requireRole(loadJob(db, jobId), party, ["client"], action);
}
export function assertParty(db: Db, jobId: string, party: Party, action: string): void {
  requireRole(loadJob(db, jobId), party, ["client", "worker"], action);
}

// ---------- disputes, resubmission, hold limits (T6) ----------

/** Either party disputes a verified job before settlement: money stays held, the evidence report stays available. */
export function disputeJob(db: Db, jobId: string, party: Party, reason: string): void {
  const job = loadJob(db, jobId);
  requireRole(job, party, ["client", "worker"], "dispute it");
  transition(db, jobId, "DISPUTED", { actor: party.id, expectedFrom: "VERIFIED", payload: { reason } });
}

/** Only the party who opened the dispute can withdraw it; the job goes back to VERIFIED and can be settled. */
export function withdrawDispute(db: Db, jobId: string, party: Party): void {
  const job = loadJob(db, jobId);
  requireRole(job, party, ["client", "worker"], "withdraw a dispute");
  const opened = db
    .select()
    .from(events)
    .where(and(eq(events.jobId, jobId), eq(events.type, "STATUS_CHANGED")))
    .orderBy(desc(events.id))
    .all()
    .find((e) => e.payload?.to === "DISPUTED");
  if (job.status !== "DISPUTED" || !opened) throw new JobInputError(`job ${jobId} is ${job.status}; there is no open dispute`);
  if (opened.actor !== party.id) throw new ForbiddenError(`Only the party who opened the dispute (${opened.actor}) can withdraw it.`);
  transition(db, jobId, "VERIFIED", { actor: party.id, expectedFrom: "DISPUTED", payload: { dispute_withdrawn: true } });
}

export const MAX_RESUBMISSIONS = 1;

/**
 * The worker resubmits once after a milestone failed, before settlement (T6.4).
 * The whole contract is verified again in a new round (the deliverable changed,
 * so earlier passes are not carried over), and the client's earlier decisions
 * lapse (they were about the old delivery; they stay in the event log).
 */
export function resubmitWork(db: Db, jobId: string, party: Party, deliverableUrl: string): void {
  const job = loadJob(db, jobId);
  requireRole(job, party, ["worker"], "resubmit work");
  if (job.status !== "VERIFIED") throw new JobInputError(`job ${jobId} is ${job.status}; resubmission is possible only after verification and before settlement`);
  const view = jobView(db, jobId);
  if (!view.milestones.some((m) => m.outcome === "failed")) throw new JobInputError("no milestone failed, so there is nothing to resubmit");
  const used = db.select().from(events).where(and(eq(events.jobId, jobId), eq(events.type, "WORK_RESUBMITTED"))).all().length;
  if (used >= MAX_RESUBMISSIONS) throw new JobInputError(`the worker may resubmit at most ${MAX_RESUBMISSIONS} time(s), and already has`);
  const url = checkDeliverableUrl(deliverableUrl);
  const lapsed = db.select().from(clientDecisions).where(eq(clientDecisions.jobId, jobId)).all();
  db.transaction((tx) => {
    tx.delete(clientDecisions).where(eq(clientDecisions.jobId, jobId)).run();
  });
  recordEvent(db, jobId, "WORK_RESUBMITTED", {
    actor: party.id,
    payload: { deliverable_url: url, previous_url: job.deliverableUrl, lapsed_decisions: lapsed.map(({ m, i, decision }) => ({ m, i, decision })) },
  });
  transition(db, jobId, "DELIVERED", { actor: party.id, expectedFrom: "VERIFIED", set: { deliverableUrl: url }, payload: { deliverable_url: url, resubmission: true } });
}

/** How long PayPal holds funds on each rail before they move without Kept (CLAUDE.md 6.5, 7). */
export const HOLD_LIMIT_DAYS: Record<RailName, number> = { delayed_disbursement: 28, auth_capture: 29 };
export const HOLD_RULE: Record<RailName, string> = {
  delayed_disbursement: "PayPal disburses held funds to the worker automatically after 28 days, so a silent client cannot block payment.",
  auth_capture: "A PayPal authorization is honored for 3 days and expires after 29; if it expires uncaptured the hold is released to the client.",
};

function holdInfo(db: Db, job: JobRow) {
  if (!["FUNDED", "DELIVERED", "VERIFYING", "VERIFIED", "DISPUTED"].includes(job.status)) return null;
  const funded = db
    .select()
    .from(events)
    .where(and(eq(events.jobId, job.id), eq(events.type, "STATUS_CHANGED")))
    .orderBy(asc(events.id))
    .all()
    .find((e) => e.payload?.to === "FUNDED");
  if (!funded) return null;
  const days = HOLD_LIMIT_DAYS[job.rail];
  const expires = new Date(new Date(funded.createdAt).getTime() + days * 86_400_000);
  return { funded_at: funded.createdAt, expires_at: expires.toISOString(), limit_days: days, rule: HOLD_RULE[job.rail] };
}

// ---------- read models ----------

export const ListJobsQuery = z.strictObject({
  party: z.string().optional(),
  status: z.enum(JOB_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function listJobs(db: Db, query: z.input<typeof ListJobsQuery>) {
  const q = ListJobsQuery.parse(query);
  const conds = [];
  if (q.party) conds.push(or(eq(jobs.clientId, q.party), eq(jobs.workerId, q.party))!);
  if (q.status) conds.push(eq(jobs.status, q.status));
  return db
    .select()
    .from(jobs)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(q.limit)
    .all()
    .map((j) => ({
      id: j.id,
      title: j.title,
      status: j.status,
      client_id: j.clientId,
      worker_id: j.workerId,
      currency: j.currency,
      total_cents: j.totalAmountCents,
      created_at: j.createdAt,
    }));
}

/** Everything about a job a client, worker or UI needs, in one object. */
export function jobView(db: Db, jobId: string) {
  const job = loadJob(db, jobId);
  const checklist = job.status === "DRAFT" ? null : loadChecklist(db, jobId);
  const ms = db.select().from(milestones).where(eq(milestones.jobId, jobId)).orderBy(asc(milestones.position)).all();
  const items = ms.length
    ? db.select().from(checklistItems).where(inArray(checklistItems.milestoneId, ms.map((m) => m.id))).orderBy(asc(checklistItems.position)).all()
    : [];
  const decisions = db.select().from(clientDecisions).where(eq(clientDecisions.jobId, jobId)).all();
  const certRow = db.select().from(quorumCertificates).where(eq(quorumCertificates.jobId, jobId)).orderBy(desc(quorumCertificates.round)).get();
  const cert = certRow ? QuorumCertificate.safeParse(certRow.certificate) : undefined;
  const outcomes: MilestoneOutcome[] | undefined =
    checklist && cert?.success ? milestoneOutcomes(checklist, cert.data.items, decisions.map(({ m, i, decision }) => ({ m, i, decision }))) : undefined;
  const round = db.select({ r: max(verifierRuns.round) }).from(verifierRuns).where(eq(verifierRuns.jobId, jobId)).get()?.r;
  const runs = round
    ? db.select().from(verifierRuns).where(and(eq(verifierRuns.jobId, jobId), eq(verifierRuns.round, round))).orderBy(asc(verifierRuns.verifierId)).all()
    : [];

  return {
    id: job.id,
    title: job.title,
    brief: job.brief,
    status: job.status,
    client_id: job.clientId,
    worker_id: job.workerId,
    currency: job.currency,
    total_cents: job.totalAmountCents,
    rail: job.rail,
    checklist_hash: job.checklistHash ?? (checklist ? checklistHash(checklist) : null),
    checklist_frozen: job.checklistHash !== null,
    acceptances: acceptances(db, job),
    checklist,
    paypal_order_id: job.paypalOrderId,
    deliverable_url: job.deliverableUrl,
    created_at: job.createdAt,
    /** While PayPal holds the money: when it moves without Kept (T6.1). */
    hold: holdInfo(db, job),
    resubmissions_left: Math.max(0, MAX_RESUBMISSIONS - db.select().from(events).where(and(eq(events.jobId, job.id), eq(events.type, "WORK_RESUBMITTED"))).all().length),
    milestones: ms.map((m) => ({
      m: m.position,
      id: m.id,
      title: m.title,
      amount_cents: m.amountCents,
      status: m.status,
      outcome: outcomes?.[m.position] ?? null,
      paypal: { capture_id: m.paypalCaptureId, release_id: m.paypalReleaseId, refund_id: m.paypalRefundId },
      items: items
        .filter((it) => it.milestoneId === m.id)
        .map((it) => {
          const d = decisions.find((x) => x.m === m.position && x.i === it.position);
          return {
            i: it.position,
            description: it.description,
            check_type: it.checkType,
            verdict: it.verdict,
            verdict_reason: it.verdictReason,
            client_decision: d ? { decision: d.decision, note: d.note, at: d.createdAt } : null,
          };
        }),
    })),
    verification: round
      ? {
          round,
          certificate_hash: certRow?.round === round ? certRow.certificateHash : null,
          runs: runs.map((r) => ({
            verifier_id: r.verifierId,
            browser: r.browser,
            judge_model: r.judgeModel,
            status: r.status,
            error: r.error,
            merkle_root: r.merkleRoot,
            replay_url: r.replayUrl,
          })),
        }
      : null,
  };
}

/** The job's event log, oldest first. */
export function jobEvents(db: Db, jobId: string) {
  loadJob(db, jobId);
  return db
    .select()
    .from(events)
    .where(eq(events.jobId, jobId))
    .orderBy(asc(events.id))
    .all()
    .map((e) => ({ id: e.id, type: e.type, actor: e.actor, payload: e.payload, at: e.createdAt }));
}

const MONEY_EVENTS = new Set(["MILESTONE_RELEASED", "MILESTONE_REFUNDED", "RAIL_FINALIZED", "SETTLEMENT_STARTED", "SETTLEMENT_INTERRUPTED", "SETTLEMENT_REFUSED"]);
const MONEY_STATUSES = new Set<JobStatus>(["FUNDING_PENDING", "FUNDED", "SETTLED", "AUTO_RELEASED", "CANCELLED"]);

/**
 * Money view of one job. Gross amounts in cents; PayPal's fees and net
 * amounts come from the rail's status() once the PayPal rail exists (T2.3, T5.3).
 */
export function ledger(db: Db, jobId: string) {
  const job = loadJob(db, jobId);
  const ms = db.select().from(milestones).where(eq(milestones.jobId, jobId)).orderBy(asc(milestones.position)).all();
  const sum = (s: string) => ms.filter((m) => m.status === s).reduce((t, m) => t + m.amountCents, 0);
  const released = sum("released");
  const refunded = sum("refunded");
  const funded = ["FUNDED", "DELIVERED", "VERIFYING", "VERIFIED", "DISPUTED", "SETTLED"].includes(job.status);
  const entries = db
    .select()
    .from(events)
    .where(eq(events.jobId, jobId))
    .orderBy(asc(events.id))
    .all()
    .filter((e) => MONEY_EVENTS.has(e.type) || (e.type === "STATUS_CHANGED" && MONEY_STATUSES.has(e.payload?.to as JobStatus)))
    .map((e) => ({ type: e.type, actor: e.actor, payload: e.payload, at: e.createdAt }));
  return {
    job_id: job.id,
    status: job.status,
    currency: job.currency,
    total_cents: job.totalAmountCents,
    held_cents: funded ? job.totalAmountCents - released - refunded : 0,
    released_cents: released,
    refunded_cents: refunded,
    paypal_order_id: job.paypalOrderId,
    milestones: ms.map((m) => ({
      m: m.position,
      title: m.title,
      amount_cents: m.amountCents,
      status: m.status,
      paypal: { capture_id: m.paypalCaptureId, release_id: m.paypalReleaseId, refund_id: m.paypalRefundId },
    })),
    entries,
  };
}
