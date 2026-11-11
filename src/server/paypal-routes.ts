import express, { type Router } from "express";
import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import { buildRailJob } from "../core/settlement.js";
import { recordEvent } from "../core/state.js";
import type { Db } from "../db/client.js";
import { jobs, milestones } from "../db/schema.js";
import type { PayPalClient } from "../paypal/client.js";
import type { PaymentRail } from "../rails/types.js";

/**
 * T2.7: reading the truth back from PayPal.
 *
 *   GET  /jobs/:id/paypal      what PayPal itself reports for the job's order (held, released, refunded)
 *   POST /paypal/webhook       PayPal webhooks, accepted only after PayPal verifies the signature
 *                              (POST /v1/notifications/verify-webhook-signature with PAYPAL_WEBHOOK_ID)
 *
 * Webhooks need a public URL, so locally Kept polls GET /jobs/:id/paypal instead.
 * A verified webhook is recorded on the job it belongs to as a PAYPAL_WEBHOOK event;
 * money state is still changed only by Kept's own calls (settlement), never by a webhook.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const HEADER = {
  auth_algo: "paypal-auth-algo",
  cert_url: "paypal-cert-url",
  transmission_id: "paypal-transmission-id",
  transmission_sig: "paypal-transmission-sig",
  transmission_time: "paypal-transmission-time",
} as const;

/** The PayPal order a webhook resource belongs to, if it says. */
export function orderIdOf(event: Json): string | undefined {
  const r = event.resource ?? {};
  return r.supplementary_data?.related_ids?.order_id ?? (String(event.event_type ?? "").startsWith("CHECKOUT.ORDER") ? r.id : undefined);
}

export function paypalRouter(config: Config, deps: { db: Db; rail?: PaymentRail; paypal?: PayPalClient }): Router {
  const r = express.Router();
  const { db } = deps;

  r.get("/jobs/:id/paypal", async (req, res, next) => {
    try {
      if (!deps.rail) {
        res.status(503).json({ error: "No PayPal rail is configured on this server yet (task T2.3)." });
        return;
      }
      const job = buildRailJob(db, req.params.id);
      const s = await deps.rail.status(job);
      res.json({ job_id: job.id, rail: deps.rail.name, paypal_order_id: job.paypalOrderId, order_status: s.orderStatus, held_cents: s.heldCents, released_cents: s.releasedCents, refunded_cents: s.refundedCents });
    } catch (err) {
      next(err);
    }
  });

  r.post("/paypal/webhook", async (req, res) => {
    const webhookId = config.paypal.webhookId;
    if (!deps.paypal || !webhookId) {
      res.status(503).json({ error: "Webhooks are not configured (PAYPAL_WEBHOOK_ID and PayPal keys)." });
      return;
    }
    const headers = Object.fromEntries(Object.entries(HEADER).map(([field, h]) => [field, req.get(h)]));
    if (Object.values(headers).some((v) => !v)) {
      res.status(400).json({ error: "missing PayPal transmission headers" });
      return;
    }
    let verified: boolean;
    try {
      const v = await deps.paypal.post<Json>("/v1/notifications/verify-webhook-signature", { body: { ...headers, webhook_id: webhookId, webhook_event: req.body } });
      verified = v.body?.verification_status === "SUCCESS";
    } catch {
      verified = false;
    }
    if (!verified) {
      res.status(401).json({ error: "webhook signature not verified by PayPal" });
      return;
    }
    const event = req.body as Json;
    const orderId = orderIdOf(event);
    const captureId = String(event.event_type ?? "").startsWith("PAYMENT.CAPTURE") ? event.resource?.id : undefined;
    const job =
      (orderId && db.select({ id: jobs.id }).from(jobs).where(eq(jobs.paypalOrderId, orderId)).get()) ||
      (captureId && db.select({ id: milestones.jobId }).from(milestones).where(eq(milestones.paypalCaptureId, captureId)).get()) ||
      undefined;
    if (job) {
      recordEvent(db, job.id, "PAYPAL_WEBHOOK", {
        actor: "paypal",
        payload: { event_id: event.id ?? null, event_type: event.event_type ?? null, resource_id: event.resource?.id ?? null, status: event.resource?.status ?? null },
      });
    }
    res.json({ ok: true, job_id: job?.id ?? null });
  });

  return r;
}
