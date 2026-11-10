import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { openDb } from "../src/db/client.js";
import { events, jobs, parties } from "../src/db/schema.js";
import { DEMO_CLIENT_ID, seedDemoParties } from "../src/db/seed.js";

const env = {
  DEMO_CLIENT_EMAIL: "buyer@example.com",
  DEMO_WORKER_EMAIL: "worker@example.com",
  DEMO_WORKER_MERCHANT_ID: "MERCHANT123",
};

describe("database", () => {
  it("migrates a fresh database and stores a job with events", () => {
    const db = openDb(":memory:");
    seedDemoParties(db, loadConfig(env));
    db.insert(jobs)
      .values({ id: "job_1", title: "T", brief: "B", clientId: DEMO_CLIENT_ID, totalAmountCents: 10000, rail: "auth_capture" })
      .run();
    db.insert(events).values({ jobId: "job_1", type: "CREATED", actor: DEMO_CLIENT_ID, payload: { a: 1 } }).run();
    const job = db.select().from(jobs).get();
    expect(job?.status).toBe("DRAFT");
    expect(job?.createdAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect(db.select().from(events).get()?.payload).toEqual({ a: 1 });
  });

  it("seed is idempotent", () => {
    const db = openDb(":memory:");
    const config = loadConfig(env);
    seedDemoParties(db, config);
    seedDemoParties(db, config);
    const rows = db.select().from(parties).all();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.kind === "agent")?.paypalMerchantId).toBe("MERCHANT123");
  });

  it("seed names missing demo keys", () => {
    expect(() => seedDemoParties(openDb(":memory:"), loadConfig({}))).toThrow(ConfigError);
  });
});
