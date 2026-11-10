import { asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { checklistItems, jobs, milestones, type JobStatus } from "../db/schema.js";
import { checklistHash, parseChecklist, type Checklist, type ChecklistItem } from "./checklist.js";
import { JobNotFoundError, transition } from "./state.js";

/** The checklist can only be written while it is still a proposal. */
const EDITABLE: readonly JobStatus[] = ["DRAFT", "CHECKLIST_PROPOSED"];

export class ChecklistFrozenError extends Error {
  constructor(
    readonly jobId: string,
    readonly status: JobStatus,
  ) {
    super(`Checklist for job ${jobId} is frozen (status ${status}); it can only change before AGREED.`);
    this.name = "ChecklistFrozenError";
  }
}

export class ChecklistTamperedError extends Error {
  constructor(
    readonly jobId: string,
    readonly stored: string | null,
    readonly recomputed: string,
  ) {
    super(`Checklist hash mismatch for job ${jobId}: stored ${stored ?? "none"}, recomputed ${recomputed}.`);
    this.name = "ChecklistTamperedError";
  }
}

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

/**
 * Replaces the job's milestones and items with this checklist. Allowed only in
 * DRAFT or CHECKLIST_PROPOSED; also updates the job's currency and total so
 * they always match the checklist.
 */
export function saveChecklist(db: Db, jobId: string, input: unknown): Checklist {
  const checklist = parseChecklist(input);
  db.transaction((tx) => {
    const job = tx.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)).get();
    if (!job) throw new JobNotFoundError(jobId);
    if (!EDITABLE.includes(job.status)) throw new ChecklistFrozenError(jobId, job.status);

    const oldMilestones = tx.select({ id: milestones.id }).from(milestones).where(eq(milestones.jobId, jobId)).all();
    if (oldMilestones.length) {
      const ids = oldMilestones.map((m) => m.id);
      tx.delete(checklistItems).where(inArray(checklistItems.milestoneId, ids)).run();
      tx.delete(milestones).where(inArray(milestones.id, ids)).run();
    }
    checklist.milestones.forEach((m, mi) => {
      const milestoneId = newId("ms");
      tx.insert(milestones)
        .values({ id: milestoneId, jobId, position: mi, title: m.title, amountCents: m.amount_cents })
        .run();
      m.items.forEach((item, ii) => {
        tx.insert(checklistItems)
          .values({
            id: newId("item"),
            milestoneId,
            position: ii,
            description: item.description,
            checkType: item.check_type,
            params: item.params as Record<string, unknown>,
          })
          .run();
      });
    });
    tx.update(jobs)
      .set({ currency: checklist.currency, totalAmountCents: checklist.total_cents })
      .where(eq(jobs.id, jobId))
      .run();
  });
  return checklist;
}

/** Rebuilds the checklist from the database rows, in stored order. */
export function loadChecklist(db: Db, jobId: string): Checklist {
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw new JobNotFoundError(jobId);
  const ms = db.select().from(milestones).where(eq(milestones.jobId, jobId)).orderBy(asc(milestones.position)).all();
  const items = ms.length
    ? db
        .select()
        .from(checklistItems)
        .where(inArray(checklistItems.milestoneId, ms.map((m) => m.id)))
        .orderBy(asc(checklistItems.position))
        .all()
    : [];
  return parseChecklist({
    version: 1,
    currency: job.currency,
    total_cents: job.totalAmountCents,
    milestones: ms.map((m) => ({
      title: m.title,
      amount_cents: m.amountCents,
      items: items
        .filter((i) => i.milestoneId === m.id)
        .map((i) => ({ description: i.description, check_type: i.checkType, params: i.params }) as ChecklistItem),
    })),
  });
}

/**
 * Freezes the checklist: computes its hash, stores it on the job and moves
 * CHECKLIST_PROPOSED → AGREED in one transaction. Call once both parties accepted.
 */
export function agreeChecklist(db: Db, jobId: string, actor: string): string {
  const hash = checklistHash(loadChecklist(db, jobId));
  transition(db, jobId, "AGREED", {
    actor,
    expectedFrom: "CHECKLIST_PROPOSED",
    set: { checklistHash: hash },
    payload: { checklist_hash: hash },
  });
  return hash;
}

/** Recomputes the hash from stored rows and throws if it differs from the frozen one. */
export function assertChecklistIntact(db: Db, jobId: string): string {
  const job = db.select({ checklistHash: jobs.checklistHash }).from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw new JobNotFoundError(jobId);
  const recomputed = checklistHash(loadChecklist(db, jobId));
  if (job.checklistHash !== recomputed) throw new ChecklistTamperedError(jobId, job.checklistHash, recomputed);
  return recomputed;
}
