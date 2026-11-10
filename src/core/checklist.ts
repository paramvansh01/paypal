import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The checklist is the contract both parties agree to before money is locked.
 * Section 6.6: canonical JSON (keys sorted, no whitespace, arrays in order),
 * hashed with SHA-256. The hash goes on the job and into the PayPal order's
 * custom_id, so anyone can recompute it and check nothing changed.
 *
 * Checks address the deliverable by `path`, relative to the URL the worker
 * submits later, because the checklist is agreed before delivery exists.
 */

const path = z
  .string()
  .regex(/^\/[^\s]*$/, "must start with / (relative to the deliverable URL)")
  .default("/");

const strictObj = <T extends z.ZodRawShape>(shape: T) => z.strictObject(shape);
const description = z.string().min(1).max(500);

export const CheckSpec = z.discriminatedUnion("check_type", [
  strictObj({
    description,
    check_type: z.literal("http_status"),
    params: strictObj({ path, expected: z.number().int().min(100).max(599).default(200) }),
  }),
  strictObj({
    description,
    check_type: z.literal("text_present"),
    params: strictObj({ path, text: z.string().min(1) }),
  }),
  strictObj({
    description,
    check_type: z.literal("element_exists"),
    params: strictObj({ path, selector: z.string().min(1) }),
  }),
  strictObj({
    description,
    check_type: z.literal("form_submits"),
    params: strictObj({
      path,
      form_selector: z.string().min(1).default("form"),
      /** CSS selector → value to type. */
      fields: z.record(z.string().min(1), z.string()),
      success: strictObj({
        text: z.string().min(1).optional(),
        url_contains: z.string().min(1).optional(),
        response_status: z.number().int().min(100).max(599).optional(),
      }).refine((s) => s.text || s.url_contains || s.response_status, "needs at least one success signal"),
    }),
  }),
  strictObj({
    description,
    check_type: z.literal("load_time_under"),
    params: strictObj({ path, ms: z.number().int().positive().max(60_000) }),
  }),
  strictObj({
    description,
    check_type: z.literal("mobile_no_overflow"),
    params: strictObj({ path, viewport_width: z.number().int().min(240).max(800).default(390) }),
  }),
  strictObj({
    description,
    check_type: z.literal("links_ok"),
    params: strictObj({ path, max_links: z.number().int().positive().max(200).default(50) }),
  }),
  strictObj({
    description,
    check_type: z.literal("json_schema_valid"),
    params: strictObj({ path, schema: z.record(z.string(), z.unknown()) }),
  }),
  strictObj({
    description,
    check_type: z.literal("llm_judgement"),
    /** A narrow yes/no question. The answer is always shown as "AI opinion". */
    params: strictObj({ path, question: z.string().min(5).max(500) }),
  }),
  strictObj({
    description,
    check_type: z.literal("client_approval"),
    params: strictObj({}),
  }),
]);

export const ChecklistItem = CheckSpec;

export const Milestone = z.strictObject({
  title: z.string().min(1).max(200),
  amount_cents: z.number().int().positive(),
  items: z.array(ChecklistItem).min(1).max(20),
});

export const Checklist = z
  .strictObject({
    version: z.literal(1),
    currency: z.string().regex(/^[A-Z]{3}$/),
    total_cents: z.number().int().positive(),
    milestones: z.array(Milestone).min(1).max(10),
  })
  .superRefine((c, ctx) => {
    const sum = c.milestones.reduce((s, m) => s + m.amount_cents, 0);
    if (sum !== c.total_cents) {
      ctx.addIssue({
        code: "custom",
        path: ["milestones"],
        message: `milestone amounts add up to ${sum} but total_cents is ${c.total_cents}`,
      });
    }
  });

export type Checklist = z.output<typeof Checklist>;
export type ChecklistInput = z.input<typeof Checklist>;
export type ChecklistItem = z.output<typeof ChecklistItem>;
export type CheckType = ChecklistItem["check_type"];

/** Validates and normalises (fills defaults), so equal contracts always hash equally. */
export function parseChecklist(input: unknown): Checklist {
  return Checklist.parse(input);
}

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit (JS default sort),
 * arrays kept in order, no whitespace, numbers as JSON.stringify writes them.
 * For our data (strings, integers, booleans) this matches RFC 8785 (JCS).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
}

/** SHA-256 of the canonical JSON of the normalised checklist, 64 lowercase hex characters. */
export function checklistHash(input: unknown): string {
  return createHash("sha256").update(canonicalJson(parseChecklist(input)), "utf8").digest("hex");
}
