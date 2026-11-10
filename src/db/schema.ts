import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Data model from CLAUDE.md section 6.4.
 * Money is stored as integer minor units (cents) to avoid float rounding.
 * Timestamps are ISO 8601 strings in UTC.
 */

const createdAt = () =>
  text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);

export const parties = sqliteTable(
  "parties",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["human", "agent"] }).notNull(),
    displayName: text("display_name").notNull(),
    paypalEmail: text("paypal_email"),
    paypalMerchantId: text("paypal_merchant_id"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("parties_paypal_email_kind_uq").on(t.paypalEmail, t.kind)],
);

export const JOB_STATUSES = [
  "DRAFT",
  "CHECKLIST_PROPOSED",
  "AGREED",
  "FUNDING_PENDING",
  "FUNDED",
  "DELIVERED",
  "VERIFYING",
  "VERIFIED",
  "SETTLED",
  "CANCELLED",
  "DISPUTED",
  "AUTO_RELEASED",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    brief: text("brief").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => parties.id),
    workerId: text("worker_id").references(() => parties.id),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("DRAFT"),
    currency: text("currency").notNull().default("USD"),
    totalAmountCents: integer("total_amount_cents").notNull(),
    checklistHash: text("checklist_hash"),
    paypalOrderId: text("paypal_order_id"),
    rail: text("rail", { enum: ["delayed_disbursement", "auth_capture"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("jobs_client_idx").on(t.clientId), index("jobs_worker_idx").on(t.workerId)],
);

export const MILESTONE_STATUSES = ["pending", "passed", "failed", "released", "refunded"] as const;

export const milestones = sqliteTable(
  "milestones",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    amountCents: integer("amount_cents").notNull(),
    status: text("status", { enum: MILESTONE_STATUSES }).notNull().default("pending"),
    paypalCaptureId: text("paypal_capture_id"),
    paypalReleaseId: text("paypal_release_id"),
    paypalRefundId: text("paypal_refund_id"),
  },
  (t) => [uniqueIndex("milestones_job_position_uq").on(t.jobId, t.position)],
);

export const CHECK_TYPES = [
  "http_status",
  "text_present",
  "element_exists",
  "form_submits",
  "load_time_under",
  "mobile_no_overflow",
  "links_ok",
  "json_schema_valid",
  "llm_judgement",
  "client_approval",
] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

export const checklistItems = sqliteTable(
  "checklist_items",
  {
    id: text("id").primaryKey(),
    milestoneId: text("milestone_id")
      .notNull()
      .references(() => milestones.id),
    position: integer("position").notNull(),
    description: text("description").notNull(),
    checkType: text("check_type", { enum: CHECK_TYPES }).notNull(),
    params: text("params", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    verdict: text("verdict", { enum: ["pass", "fail", "needs_client"] }),
    evidenceId: text("evidence_id"),
  },
  (t) => [uniqueIndex("items_milestone_position_uq").on(t.milestoneId, t.position)],
);

export const evidence = sqliteTable("evidence", {
  id: text("id").primaryKey(),
  itemId: text("item_id")
    .notNull()
    .references(() => checklistItems.id),
  summary: text("summary").notNull(),
  measuredValue: text("measured_value"),
  screenshotPath: text("screenshot_path"),
  replayUrl: text("replay_url"),
  raw: text("raw", { mode: "json" }).$type<unknown>(),
  createdAt: createdAt(),
});

/** Append-only. Never update or delete rows. */
export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    type: text("type").notNull(),
    actor: text("actor").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("events_job_idx").on(t.jobId)],
);
