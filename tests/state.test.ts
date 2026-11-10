import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/client.js";
import { events, jobs, JOB_STATUSES, type JobStatus } from "../src/db/schema.js";
import { DEMO_CLIENT_ID, seedDemoParties } from "../src/db/seed.js";
import {
  canTransition,
  IllegalTransitionError,
  JobNotFoundError,
  recordEvent,
  TERMINAL_STATUSES,
  transition,
  TRANSITIONS,
} from "../src/core/state.js";

let db: Db;

beforeEach(() => {
  db = openDb(":memory:");
  seedDemoParties(db, loadConfig({ DEMO_CLIENT_EMAIL: "c@example.com", DEMO_WORKER_EMAIL: "w@example.com" }));
});

function jobIn(status: JobStatus, id = `job_${status}`): string {
  db.insert(jobs)
    .values({ id, title: "t", brief: "b", clientId: DEMO_CLIENT_ID, totalAmountCents: 1000, rail: "auth_capture", status })
    .run();
  return id;
}

const statusOf = (id: string) => db.select().from(jobs).where(eq(jobs.id, id)).get()?.status;
const eventsOf = (id: string) => db.select().from(events).where(eq(events.jobId, id)).all();

const allPairs = JOB_STATUSES.flatMap((from) => JOB_STATUSES.map((to) => [from, to] as const));
const legal = allPairs.filter(([f, t]) => canTransition(f, t));
const illegal = allPairs.filter(([f, t]) => !canTransition(f, t));

describe("state graph", () => {
  it("follows the main path from DRAFT to SETTLED", () => {
    const id = jobIn("DRAFT");
    const path: JobStatus[] = [
      "CHECKLIST_PROPOSED", "AGREED", "FUNDING_PENDING", "FUNDED", "DELIVERED", "VERIFYING", "VERIFIED", "SETTLED",
    ];
    for (const to of path) transition(db, id, to, { actor: "test" });
    expect(statusOf(id)).toBe("SETTLED");
    expect(eventsOf(id).map((e) => (e.payload as { to: string }).to)).toEqual(path);
  });

  it("only allows cancelling before money is held", () => {
    const cancellable = JOB_STATUSES.filter((s) => canTransition(s, "CANCELLED"));
    expect(cancellable).toEqual(["DRAFT", "CHECKLIST_PROPOSED", "AGREED", "FUNDING_PENDING"]);
  });

  it("only auto-releases while PayPal holds the funds", () => {
    const releasable = JOB_STATUSES.filter((s) => canTransition(s, "AUTO_RELEASED"));
    expect(releasable).toEqual(["FUNDED", "DELIVERED", "VERIFYING", "VERIFIED", "DISPUTED"]);
  });

  it("has exactly three final states", () => {
    expect(TERMINAL_STATUSES).toEqual(["SETTLED", "CANCELLED", "AUTO_RELEASED"]);
  });

  it("every state is reachable from DRAFT", () => {
    const seen = new Set<JobStatus>(["DRAFT"]);
    const queue: JobStatus[] = ["DRAFT"];
    while (queue.length) {
      for (const next of TRANSITIONS[queue.shift()!]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...JOB_STATUSES].sort());
  });
});

describe("transition()", () => {
  it.each(legal)("allows %s → %s and logs it", (from, to) => {
    const id = jobIn(from);
    expect(transition(db, id, to, { actor: "tester", payload: { note: "x" } })).toEqual({ from, to });
    expect(statusOf(id)).toBe(to);
    const [ev] = eventsOf(id);
    expect(ev).toMatchObject({ type: "STATUS_CHANGED", actor: "tester", payload: { from, to, note: "x" } });
  });

  it.each(illegal)("rejects %s → %s without side effects", (from, to) => {
    const id = jobIn(from);
    expect(() => transition(db, id, to, { actor: "tester" })).toThrow(IllegalTransitionError);
    expect(statusOf(id)).toBe(from);
    expect(eventsOf(id)).toHaveLength(0);
  });

  it("rejects a stale expectedFrom", () => {
    const id = jobIn("AGREED");
    expect(() => transition(db, id, "FUNDING_PENDING", { actor: "a", expectedFrom: "CHECKLIST_PROPOSED" })).toThrow(
      IllegalTransitionError,
    );
    transition(db, id, "FUNDING_PENDING", { actor: "a", expectedFrom: ["AGREED"] });
    expect(statusOf(id)).toBe("FUNDING_PENDING");
  });

  it("applies extra column updates atomically", () => {
    const id = jobIn("AGREED");
    transition(db, id, "FUNDING_PENDING", { actor: "a", set: { paypalOrderId: "ORDER-1" } });
    expect(db.select().from(jobs).where(eq(jobs.id, id)).get()?.paypalOrderId).toBe("ORDER-1");
  });

  it("names a missing job", () => {
    expect(() => transition(db, "nope", "AGREED", { actor: "a" })).toThrow(JobNotFoundError);
  });

  it("recordEvent appends non-status events", () => {
    const id = jobIn("FUNDED");
    recordEvent(db, id, "PAYPAL_CAPTURED", { actor: "paypal", payload: { captureId: "C1" } });
    expect(eventsOf(id)[0]).toMatchObject({ type: "PAYPAL_CAPTURED", payload: { captureId: "C1" } });
  });
});
