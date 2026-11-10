import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  agreeChecklist,
  assertChecklistIntact,
  ChecklistFrozenError,
  ChecklistTamperedError,
  loadChecklist,
  saveChecklist,
} from "../src/core/checklist-store.js";
import { canonicalJson, checklistHash, parseChecklist, type ChecklistInput } from "../src/core/checklist.js";
import { transition } from "../src/core/state.js";
import { openDb, type Db } from "../src/db/client.js";
import { checklistItems, jobs } from "../src/db/schema.js";
import { DEMO_CLIENT_ID, seedDemoParties } from "../src/db/seed.js";

const sample = (): ChecklistInput => ({
  version: 1,
  currency: "USD",
  total_cents: 10000,
  milestones: [
    {
      title: "Landing page live",
      amount_cents: 4000,
      items: [
        { description: "Home page loads", check_type: "http_status", params: { path: "/", expected: 200 } },
        { description: "Shows the product name", check_type: "text_present", params: { text: "Acme Widgets" } },
      ],
    },
    {
      title: "Contact form works",
      amount_cents: 3000,
      items: [
        {
          description: "Contact form submits",
          check_type: "form_submits",
          params: {
            path: "/contact",
            fields: { "#email": "test@example.com", "#message": "Hello" },
            success: { text: "Thanks" },
          },
        },
      ],
    },
    {
      title: "Looks right",
      amount_cents: 3000,
      items: [
        { description: "No sideways scroll on phones", check_type: "mobile_no_overflow", params: {} },
        { description: "Client likes the design", check_type: "client_approval", params: {} },
      ],
    },
  ],
});

/** Rebuilds every object with its keys in reverse order. */
function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)]));
  }
  return v;
}

describe("canonicalJson", () => {
  it("sorts keys at every level, keeps array order, no whitespace", () => {
    expect(canonicalJson({ b: 1, a: [3, { d: true, c: null }], "é": "x" })).toBe(
      '{"a":[3,{"c":null,"d":true}],"b":1,"é":"x"}',
    );
  });

  it("rejects values that have no canonical form", () => {
    expect(() => canonicalJson({ a: NaN })).toThrow();
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
  });
});

describe("checklistHash", () => {
  it("is 64 hex characters", () => {
    expect(checklistHash(sample())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not depend on key order", () => {
    expect(checklistHash(reverseKeys(sample()))).toBe(checklistHash(sample()));
  });

  it("treats an omitted default the same as the explicit default", () => {
    const explicit = sample();
    explicit.milestones[2]!.items[0] = {
      description: "No sideways scroll on phones",
      check_type: "mobile_no_overflow",
      params: { path: "/", viewport_width: 390 },
    };
    expect(checklistHash(explicit)).toBe(checklistHash(sample()));
  });

  const edits: [string, (c: ChecklistInput) => void][] = [
    ["a milestone title", (c) => (c.milestones[0]!.title += "!")],
    ["an item description", (c) => (c.milestones[0]!.items[0]!.description = "Home page loads fast")],
    ["a check parameter", (c) => ((c.milestones[0]!.items[1]!.params as { text: string }).text = "Acme")],
    ["a nested form field", (c) => ((c.milestones[1]!.items[0]!.params as { fields: Record<string, string> }).fields["#email"] = "x@example.com")],
    ["the check type", (c) => (c.milestones[2]!.items[1] = { description: "Client likes the design", check_type: "llm_judgement", params: { question: "Is the design clean?" } })],
    ["milestone order", (c) => c.milestones.reverse()],
    ["item order", (c) => c.milestones[0]!.items.reverse()],
    ["amounts (same total)", (c) => ((c.milestones[0]!.amount_cents = 3000), (c.milestones[1]!.amount_cents = 4000))],
    ["the currency", (c) => (c.currency = "EUR")],
  ];
  it.each(edits)("changes when %s changes", (_name, edit) => {
    const c = sample();
    edit(c);
    expect(checklistHash(c)).not.toBe(checklistHash(sample()));
  });
});

describe("parseChecklist", () => {
  it("rejects amounts that do not add up to the total", () => {
    const c = sample();
    c.total_cents = 9999;
    expect(() => parseChecklist(c)).toThrow(/add up to 10000/);
  });

  it("rejects unknown keys instead of silently dropping them", () => {
    const c = sample() as unknown as { milestones: { extra?: string }[] };
    c.milestones[0]!.extra = "sneaky";
    expect(() => parseChecklist(c)).toThrow();
  });

  it("rejects unknown check types and bad params", () => {
    const c = sample();
    (c.milestones[0]!.items[0] as { check_type: string }).check_type = "run_shell";
    expect(() => parseChecklist(c)).toThrow();
    const d = sample();
    (d.milestones[0]!.items[0]!.params as { path: string }).path = "https://evil.example";
    expect(() => parseChecklist(d)).toThrow(/must start with \//);
  });

  it("needs a success signal for form checks", () => {
    const c = sample();
    (c.milestones[1]!.items[0]!.params as { success: object }).success = {};
    expect(() => parseChecklist(c)).toThrow(/success signal/);
  });
});

describe("checklist storage and freezing", () => {
  let db: Db;
  const jobId = "job_1";

  beforeEach(() => {
    db = openDb(":memory:");
    seedDemoParties(db, loadConfig({ DEMO_CLIENT_EMAIL: "c@example.com", DEMO_WORKER_EMAIL: "w@example.com" }));
    db.insert(jobs)
      .values({ id: jobId, title: "Site", brief: "b", clientId: DEMO_CLIENT_ID, totalAmountCents: 1, rail: "auth_capture" })
      .run();
  });

  it("round-trips through the database with the same hash", () => {
    saveChecklist(db, jobId, sample());
    expect(checklistHash(loadChecklist(db, jobId))).toBe(checklistHash(sample()));
    expect(db.select().from(jobs).get()?.totalAmountCents).toBe(10000);
  });

  it("replaces a proposal when saved again", () => {
    saveChecklist(db, jobId, sample());
    const smaller = sample();
    smaller.milestones = smaller.milestones.slice(0, 1);
    smaller.total_cents = 4000;
    saveChecklist(db, jobId, smaller);
    expect(loadChecklist(db, jobId).milestones).toHaveLength(1);
    expect(db.select().from(checklistItems).all()).toHaveLength(2);
  });

  it("freezes on AGREED and rejects later edits", () => {
    saveChecklist(db, jobId, sample());
    transition(db, jobId, "CHECKLIST_PROPOSED", { actor: "ai" });
    const hash = agreeChecklist(db, jobId, "both");
    expect(hash).toBe(checklistHash(sample()));
    expect(db.select().from(jobs).get()).toMatchObject({ status: "AGREED", checklistHash: hash });
    expect(() => saveChecklist(db, jobId, sample())).toThrow(ChecklistFrozenError);
    expect(assertChecklistIntact(db, jobId)).toBe(hash);
  });

  it("detects a checklist changed behind the API's back", () => {
    saveChecklist(db, jobId, sample());
    transition(db, jobId, "CHECKLIST_PROPOSED", { actor: "ai" });
    agreeChecklist(db, jobId, "both");
    const item = db.select().from(checklistItems).where(eq(checklistItems.checkType, "text_present")).get()!;
    db.update(checklistItems).set({ params: { path: "/", text: "Anything" } }).where(eq(checklistItems.id, item.id)).run();
    expect(() => assertChecklistIntact(db, jobId)).toThrow(ChecklistTamperedError);
  });

  it("cannot agree a job that was never proposed", () => {
    saveChecklist(db, jobId, sample());
    expect(() => agreeChecklist(db, jobId, "both")).toThrow(/cannot move from DRAFT to AGREED/);
  });
});
