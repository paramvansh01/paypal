import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { events, jobs, JOB_STATUSES, type JobStatus } from "../db/schema.js";

/**
 * Job lifecycle from CLAUDE.md section 6.3.
 *
 * Main path: DRAFT → CHECKLIST_PROPOSED → AGREED → FUNDING_PENDING → FUNDED →
 * DELIVERED → VERIFYING → VERIFIED → SETTLED.
 * Side exits: CANCELLED (only before money is held), DISPUTED (after VERIFIED,
 * pauses settlement), AUTO_RELEASED (PayPal's hold limit reached while funds are held).
 */
export const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  DRAFT: ["CHECKLIST_PROPOSED", "CANCELLED"],
  CHECKLIST_PROPOSED: ["AGREED", "CANCELLED"],
  AGREED: ["FUNDING_PENDING", "CANCELLED"],
  FUNDING_PENDING: ["FUNDED", "CANCELLED"],
  FUNDED: ["DELIVERED", "AUTO_RELEASED"],
  DELIVERED: ["VERIFYING", "AUTO_RELEASED"],
  // VERIFYING → DELIVERED lets a crashed or timed-out verifier run be retried.
  VERIFYING: ["VERIFIED", "DELIVERED", "AUTO_RELEASED"],
  // VERIFIED → DELIVERED: the worker resubmits once after a failed milestone (T6.4).
  VERIFIED: ["SETTLED", "DISPUTED", "DELIVERED", "AUTO_RELEASED"],
  // DISPUTED → VERIFIED: the party who opened the dispute withdraws it (T6.2).
  DISPUTED: ["VERIFIED", "SETTLED", "AUTO_RELEASED"],
  SETTLED: [],
  CANCELLED: [],
  AUTO_RELEASED: [],
};

export const TERMINAL_STATUSES = JOB_STATUSES.filter((s) => TRANSITIONS[s].length === 0);

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly jobId: string,
    readonly from: JobStatus,
    readonly to: JobStatus,
  ) {
    const allowed = TRANSITIONS[from];
    super(
      `Job ${jobId} cannot move from ${from} to ${to}. ` +
        (allowed.length ? `Allowed next states: ${allowed.join(", ")}.` : `${from} is final.`),
    );
    this.name = "IllegalTransitionError";
  }
}

export class JobNotFoundError extends Error {
  constructor(readonly jobId: string) {
    super(`Job ${jobId} not found`);
    this.name = "JobNotFoundError";
  }
}

export interface EventInput {
  actor: string;
  payload?: Record<string, unknown>;
}

/** Appends an event. The events table is append-only: never update or delete rows. */
export function recordEvent(db: Db, jobId: string, type: string, { actor, payload }: EventInput): void {
  db.insert(events).values({ jobId, type, actor, payload: payload ?? null }).run();
}

/**
 * Moves a job to `to` if the state graph allows it, and records a
 * STATUS_CHANGED event in the same database transaction. Optionally applies
 * extra column updates (e.g. paypal_order_id) in that transaction too.
 *
 * `expectedFrom` guards against acting on stale state: if set and the job is
 * not in that status, the call fails without changing anything.
 */
export function transition(
  db: Db,
  jobId: string,
  to: JobStatus,
  event: EventInput & {
    expectedFrom?: JobStatus | readonly JobStatus[];
    set?: Partial<Omit<typeof jobs.$inferInsert, "id" | "status">>;
  },
): { from: JobStatus; to: JobStatus } {
  return db.transaction((tx) => {
    const job = tx.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)).get();
    if (!job) throw new JobNotFoundError(jobId);
    const from = job.status;
    const expected = event.expectedFrom === undefined ? undefined : [event.expectedFrom].flat();
    if ((expected && !expected.includes(from)) || !canTransition(from, to)) {
      throw new IllegalTransitionError(jobId, from, to);
    }
    const updated = tx
      .update(jobs)
      .set({ ...event.set, status: to })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, from)))
      .run();
    if (updated.changes !== 1) throw new IllegalTransitionError(jobId, from, to);
    tx.insert(events)
      .values({ jobId, type: "STATUS_CHANGED", actor: event.actor, payload: { from, to, ...event.payload } })
      .run();
    return { from, to };
  });
}
