import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Data model from CLAUDE.md section 6.4.
 * Money is stored as integer minor units (cents) to avoid float rounding.
 * Timestamps are ISO 8601 strings in UTC.
 */

/** Stored copy of the contract's quorum block; validated by the checklist schema on load. */
export interface QuorumPolicyJson {
  n: number;
  k: number;
  verifiers: { id: string; public_key: string }[];
}

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
    /** Quorum policy from the contract (k, n, verifier keys). Part of the hashed contract. */
    quorum: text("quorum", { mode: "json" }).$type<QuorumPolicyJson>(),
    paypalOrderId: text("paypal_order_id"),
    /** URL the worker submitted; every verifier checks exactly this. */
    deliverableUrl: text("deliverable_url"),
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
    /** Final verdict from the quorum rule (or the client, for client_approval items). */
    verdict: text("verdict", { enum: ["pass", "fail", "needs_client"] }),
    verdictReason: text("verdict_reason", { enum: ["quorum", "no_quorum", "injection", "client"] }),
  },
  (t) => [uniqueIndex("items_milestone_position_uq").on(t.milestoneId, t.position)],
);

/** One verifier's run over a whole job (section 6.9). */
export const verifierRuns = sqliteTable(
  "verifier_runs",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    /** Groups the n runs of one verification round. */
    round: integer("round").notNull(),
    verifierId: text("verifier_id").notNull(),
    browser: text("browser").notNull(),
    judgeModel: text("judge_model").notNull(),
    deliverableUrl: text("deliverable_url").notNull(),
    status: text("status", { enum: ["running", "done", "error"] }).notNull().default("running"),
    error: text("error"),
    merkleRoot: text("merkle_root"),
    leafCount: integer("leaf_count"),
    /** The signed attestation, exactly as signed. */
    attestation: text("attestation", { mode: "json" }).$type<Record<string, unknown>>(),
    /** KERNEL replay link, when recorded. Not part of the signed evidence. */
    replayUrl: text("replay_url"),
    startedAt: createdAt(),
    finishedAt: text("finished_at"),
  },
  (t) => [uniqueIndex("verifier_runs_round_uq").on(t.jobId, t.round, t.verifierId)],
);

/** One verifier's result for one item: the exact signed leaf plus where its artifacts live. */
export const evidence = sqliteTable(
  "evidence",
  {
    id: text("id").primaryKey(),
    verifierRunId: text("verifier_run_id")
      .notNull()
      .references(() => verifierRuns.id),
    itemId: text("item_id")
      .notNull()
      .references(() => checklistItems.id),
    leafIndex: integer("leaf_index").notNull(),
    /** The LeafRecord exactly as hashed into the Merkle tree. */
    leaf: text("leaf", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    leafHash: text("leaf_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("evidence_run_leaf_uq").on(t.verifierRunId, t.leafIndex), index("evidence_item_idx").on(t.itemId)],
);

export const quorumCertificates = sqliteTable(
  "quorum_certificates",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    round: integer("round").notNull(),
    certificate: text("certificate", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    certificateHash: text("certificate_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("certificates_job_round_uq").on(t.jobId, t.round)],
);

/** The client's decision on an item the quorum left to a person. */
export const clientDecisions = sqliteTable(
  "client_decisions",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    m: integer("m").notNull(),
    i: integer("i").notNull(),
    decision: text("decision", { enum: ["approve", "reject"] }).notNull(),
    actor: text("actor").notNull(),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("client_decisions_item_uq").on(t.jobId, t.m, t.i)],
);

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
