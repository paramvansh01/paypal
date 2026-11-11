import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { jobEvents } from "../src/core/jobs.js";
import { openDb } from "../src/db/client.js";
import { jobs } from "../src/db/schema.js";
import { seedDemoParties } from "../src/db/seed.js";
import { createDeliveredDemoJob } from "../src/demo/job.js";
import { PayPalClient } from "../src/paypal/client.js";
import { loadKeyring } from "../src/qaps/keys.js";
import { verifierIds } from "../src/qaps/protocol.js";
import { orderIdOf } from "../src/server/paypal-routes.js";
import { createApp } from "../src/server/app.js";

let server: Server;
let base: string;
const verifyBodies: Record<string, unknown>[] = [];
const db = openDb(":memory:");
let jobId: string;

beforeAll(async () => {
  seedDemoParties(db, loadConfig({ DEMO_CLIENT_EMAIL: "c@example.com", DEMO_WORKER_EMAIL: "w@example.com" }));
  const keyring = loadKeyring(verifierIds(3), { dir: mkdtempSync(join(tmpdir(), "kept-wh-keys-")) });
  jobId = createDeliveredDemoJob(db, { keyring, deliverableUrl: "https://x.example/" });
  db.update(jobs).set({ paypalOrderId: "ORDER-77" }).where(eq(jobs.id, jobId)).run();
  const fakeFetch = async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith("/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
    verifyBodies.push(body);
    return new Response(JSON.stringify({ verification_status: body.transmission_sig === "good-sig" ? "SUCCESS" : "FAILURE" }), { status: 200 });
  };
  const paypal = new PayPalClient({ baseUrl: "https://api-m.sandbox.paypal.com", clientId: "c", clientSecret: "s", fetch: fakeFetch as typeof fetch });
  const app = createApp(loadConfig({ PAYPAL_WEBHOOK_ID: "WH-1" }), { db, keyring, paypal });
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

const event = { id: "WH-EVT-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-9", status: "COMPLETED", supplementary_data: { related_ids: { order_id: "ORDER-77" } } } };
const send = (sig: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/paypal/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT",
      "paypal-transmission-id": "tid",
      "paypal-transmission-sig": sig,
      "paypal-transmission-time": "2026-11-11T00:00:00Z",
      ...headers,
    },
    body: JSON.stringify(event),
  });

describe("PayPal webhook", () => {
  it("finds the order a webhook belongs to", () => {
    expect(orderIdOf(event)).toBe("ORDER-77");
    expect(orderIdOf({ event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "ORDER-1" } })).toBe("ORDER-1");
    expect(orderIdOf({ event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "R" } })).toBeUndefined();
  });

  it("asks PayPal to verify the signature; records verified events on the job and refuses the rest", async () => {
    const bad = await send("forged");
    expect(bad.status).toBe(401);
    expect(jobEvents(db, jobId).some((e) => e.type === "PAYPAL_WEBHOOK")).toBe(false);

    const ok = await send("good-sig");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, job_id: jobId });
    expect(verifyBodies.at(-1)).toMatchObject({ webhook_id: "WH-1", transmission_id: "tid", auth_algo: "SHA256withRSA", webhook_event: event });
    const recorded = jobEvents(db, jobId).filter((e) => e.type === "PAYPAL_WEBHOOK");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.payload).toMatchObject({ event_type: "PAYMENT.CAPTURE.COMPLETED", resource_id: "CAP-9" });

    expect((await send("good-sig", { "paypal-transmission-id": "" })).status).toBe(400);
  });

  it("without a rail, /jobs/:id/paypal says so", async () => {
    expect((await fetch(`${base}/jobs/${jobId}/paypal`)).status).toBe(503);
  });
});
