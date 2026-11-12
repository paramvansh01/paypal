import type { PayPalClient } from "../paypal/client.js";
import type { LockResult, MoneyContext, MoneyResult, PaymentRail, RailJob, RailCapture, RailMilestone, RailStatus } from "./types.js";

/**
 * T2.3 / T2.4: the two PayPal rails (section 6.5), written against PayPal's
 * published schemas (Orders v2, Payments v2) and the delayed-disbursement guide.
 * Field limits used here (checked against the schemas, 2026-11-11):
 *   purchase_unit.custom_id ≤ 255, invoice_id ≤ 127, reference_id ≤ 256;
 *   authorization capture: invoice_id ≤ 127, note_to_payer ≤ 255, final_capture (default false);
 *   capture refund: custom_id ≤ 127, invoice_id ≤ 127, note_to_payer ≤ 255.
 * Unproven until the sandbox spike (P1): the referenced-payouts response shape and
 * the PayPal-Auth-Assertion encoding. Results go in docs/SPIKE_RESULTS.md.
 *
 * The contract hash is the order's custom_id (it fingerprints the contract
 * before any money moves); the quorum certificate hash is written onto each
 * capture (note_to_payer) and refund (custom_id), so PayPal's own records point
 * back to the proof.
 */

export interface PayPalRailOptions {
  /** Where PayPal sends the buyer after approving or cancelling (the job page). */
  publicBaseUrl: string;
  brandName?: string;
}

export const money = (cents: number, currency: string) => ({ currency_code: currency, value: (cents / 100).toFixed(2) });
const toCents = (v: { value?: string } | undefined) => (v?.value ? Math.round(Number(v.value) * 100) : 0);

/** Every capture on an order, with PayPal's seller_receivable_breakdown (fee and net) when present. */
export function capturesOf(order: Json): RailCapture[] {
  const out: RailCapture[] = [];
  for (const pu of order.purchase_units ?? []) {
    for (const c of pu.payments?.captures ?? []) {
      const b = c.seller_receivable_breakdown;
      out.push({
        id: String(c.id),
        status: String(c.status),
        grossCents: toCents(b?.gross_amount ?? c.amount),
        feeCents: b?.paypal_fee ? toCents(b.paypal_fee) : null,
        netCents: b?.net_amount ? toCents(b.net_amount) : null,
      });
    }
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

function experienceContext(job: RailJob, opts: PayPalRailOptions) {
  const page = `${opts.publicBaseUrl.replace(/\/$/, "")}/app/jobs/${encodeURIComponent(job.id)}`;
  return {
    paypal: {
      experience_context: {
        brand_name: (opts.brandName ?? "Kept").slice(0, 127),
        shipping_preference: "NO_SHIPPING",
        user_action: "PAY_NOW",
        return_url: `${page}?paypal=approved`,
        cancel_url: `${page}?paypal=cancelled`,
      },
    },
  };
}

/** The buyer approval link: rel "payer-action" when payment_source is sent, "approve" otherwise. */
export function approveLink(order: Json): string {
  const link = (order.links as { rel: string; href: string }[] | undefined)?.find((l) => l.rel === "payer-action" || l.rel === "approve");
  if (!link) throw new Error(`PayPal order ${order.id} has no approval link`);
  return link.href;
}

const proofNote = (what: string, certificateHash: string) => `Kept: ${what}. Proof certificate ${certificateHash}`.slice(0, 255);
const invoice = (job: RailJob, suffix: string) => `kept-${job.id}-${suffix}`.slice(0, 127);

abstract class PayPalRailBase implements PaymentRail {
  abstract readonly name: PaymentRail["name"];
  constructor(
    protected readonly pp: PayPalClient,
    protected readonly opts: PayPalRailOptions,
  ) {}

  protected async order(orderId: string): Promise<Json> {
    return (await this.pp.get<Json>(`/v2/checkout/orders/${encodeURIComponent(orderId)}`)).body;
  }

  protected requireOrder(job: RailJob): string {
    if (!job.paypalOrderId) throw new Error(`job ${job.id} has no PayPal order`);
    return job.paypalOrderId;
  }

  abstract lock(job: RailJob, ctx: { requestId: string }): Promise<LockResult>;
  abstract confirmLocked(job: RailJob, ctx: { requestId: string }): Promise<{ captureIds: string[]; authorizationId?: string }>;
  abstract releaseMilestone(job: RailJob, ms: RailMilestone, ctx: MoneyContext): Promise<MoneyResult>;
  abstract refundMilestone(job: RailJob, ms: RailMilestone, ctx: MoneyContext): Promise<MoneyResult>;
  abstract status(job: RailJob): Promise<RailStatus>;
}

/**
 * Fallback rail: one AUTHORIZE order for the whole budget. Each passed milestone
 * is a partial capture of the authorization; failed milestones are never
 * captured, and finalize() voids what is left, which returns it to the buyer.
 * Needs no partner features. Authorizations expire (PayPal: honor period 3 days,
 * valid up to 29 days), so jobs on this rail must be short.
 */
export class AuthCaptureRail extends PayPalRailBase {
  readonly name = "auth_capture" as const;

  async lock(job: RailJob, ctx: { requestId: string }): Promise<LockResult> {
    if (job.paypalOrderId) {
      const existing = await this.order(job.paypalOrderId);
      return { orderId: existing.id as string, approveUrl: approveLink(existing) };
    }
    const res = await this.pp.post<Json>("/v2/checkout/orders", {
      requestId: ctx.requestId,
      body: {
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: job.id,
            custom_id: job.contractHash,
            invoice_id: invoice(job, "order"),
            description: `Kept job ${job.id}: paid per milestone, only on proof`.slice(0, 127),
            amount: money(job.totalCents, job.currency),
          },
        ],
        payment_source: experienceContext(job, this.opts),
      },
    });
    return { orderId: res.body.id as string, approveUrl: approveLink(res.body) };
  }

  async confirmLocked(job: RailJob, ctx: { requestId: string }) {
    const orderId = this.requireOrder(job);
    const res = await this.pp.post<Json>(`/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, { requestId: ctx.requestId, body: {} });
    const auth = res.body.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (!auth?.id) throw new Error(`PayPal authorized order ${orderId} but returned no authorization`);
    return { captureIds: [] as string[], authorizationId: auth.id as string };
  }

  private async authorization(job: RailJob): Promise<Json> {
    const order = await this.order(this.requireOrder(job));
    const auth = order.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (!auth?.id) throw new Error(`PayPal order ${order.id} has no authorization yet`);
    return auth;
  }

  async releaseMilestone(job: RailJob, ms: RailMilestone, ctx: MoneyContext): Promise<MoneyResult> {
    const auth = await this.authorization(job);
    const res = await this.pp.post<Json>(`/v2/payments/authorizations/${encodeURIComponent(auth.id)}/capture`, {
      requestId: ctx.requestId,
      body: {
        amount: money(ms.amountCents, job.currency),
        final_capture: false,
        invoice_id: invoice(job, `m${ms.position + 1}`),
        note_to_payer: proofNote(`milestone ${ms.position + 1} passed verification`, ctx.certificateHash),
      },
    });
    return { paypalId: res.body.id as string };
  }

  /** Nothing was captured for a failed milestone; finalize() voids the rest of the hold. */
  async refundMilestone(): Promise<MoneyResult> {
    return { paypalId: null };
  }

  async finalize(job: RailJob): Promise<MoneyResult> {
    const auth = await this.authorization(job);
    const details = (await this.pp.get<Json>(`/v2/payments/authorizations/${encodeURIComponent(auth.id)}`)).body;
    // CAPTURED: nothing left to release. VOIDED: already done (a retry).
    if (details.status === "CAPTURED" || details.status === "VOIDED") return { paypalId: null };
    await this.pp.post<Json>(`/v2/payments/authorizations/${encodeURIComponent(auth.id)}/void`, { requestId: `${auth.id}:void`.slice(0, 64) });
    return { paypalId: auth.id as string };
  }

  async status(job: RailJob): Promise<RailStatus> {
    if (!job.paypalOrderId) return { orderStatus: "NONE", heldCents: 0, releasedCents: 0, refundedCents: 0 };
    const order = await this.order(job.paypalOrderId);
    const pays = order.purchase_units?.[0]?.payments ?? {};
    const auth = pays.authorizations?.[0];
    const authorized = toCents(auth?.amount);
    const captured = (pays.captures ?? []).filter((c: Json) => c.status === "COMPLETED").reduce((s: number, c: Json) => s + toCents(c.amount), 0);
    const open = auth && (auth.status === "CREATED" || auth.status === "PARTIALLY_CAPTURED");
    return {
      orderStatus: String(order.status),
      heldCents: open ? authorized - captured : 0,
      releasedCents: captured,
      refundedCents: auth?.status === "VOIDED" || auth?.status === "CAPTURED" ? Math.max(0, authorized - captured) : 0,
      captures: capturesOf(order),
      raw: order,
    };
  }
}

/**
 * Preferred rail (multiparty delayed disbursement): one purchase unit per
 * milestone, each paying the worker (payee) with disbursement_mode DELAYED.
 * Capturing on approval makes PayPal hold every milestone's funds; a passed
 * milestone is disbursed with referenced-payouts-items, a failed one refunded.
 * Needs a partner app and a worker onboarded with DELAY_FUNDS_DISBURSEMENT.
 * PayPal disburses held funds automatically after 28 days.
 */
export class DelayedDisbursementRail extends PayPalRailBase {
  readonly name = "delayed_disbursement" as const;

  private worker(job: RailJob): string {
    if (!job.workerMerchantId) throw new Error(`the worker of job ${job.id} has no PayPal merchant ID (onboarding, T1.3)`);
    return job.workerMerchantId;
  }

  async lock(job: RailJob, ctx: { requestId: string }): Promise<LockResult> {
    if (job.paypalOrderId) {
      const existing = await this.order(job.paypalOrderId);
      return { orderId: existing.id as string, approveUrl: approveLink(existing) };
    }
    const merchantId = this.worker(job);
    const res = await this.pp.post<Json>("/v2/checkout/orders", {
      requestId: ctx.requestId,
      body: {
        intent: "CAPTURE",
        purchase_units: job.milestones.map((ms) => ({
          reference_id: ms.id,
          custom_id: job.contractHash,
          invoice_id: invoice(job, `m${ms.position + 1}`),
          description: `Kept milestone ${ms.position + 1}: ${ms.title}`.slice(0, 127),
          amount: money(ms.amountCents, job.currency),
          payee: { merchant_id: merchantId },
          payment_instruction: { disbursement_mode: "DELAYED" },
        })),
        payment_source: experienceContext(job, this.opts),
      },
    });
    return { orderId: res.body.id as string, approveUrl: approveLink(res.body) };
  }

  async confirmLocked(job: RailJob, ctx: { requestId: string }) {
    const orderId = this.requireOrder(job);
    const res = await this.pp.post<Json>(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { requestId: ctx.requestId, body: {} });
    const byRef = new Map<string, string>();
    for (const pu of res.body.purchase_units ?? []) {
      const cap = pu.payments?.captures?.[0];
      if (cap?.id) byRef.set(pu.reference_id, cap.id);
    }
    const captureIds = job.milestones.map((ms) => {
      const id = byRef.get(ms.id);
      if (!id) throw new Error(`PayPal captured order ${orderId} but returned no capture for milestone ${ms.position + 1}`);
      return id;
    });
    return { captureIds };
  }

  private capture(ms: RailMilestone): string {
    if (!ms.paypalCaptureId) throw new Error(`milestone ${ms.position + 1} has no PayPal capture`);
    return ms.paypalCaptureId;
  }

  async releaseMilestone(job: RailJob, ms: RailMilestone, ctx: MoneyContext): Promise<MoneyResult> {
    const res = await this.pp.post<Json>("/v1/payments/referenced-payouts-items", {
      requestId: ctx.requestId,
      body: { reference_id: this.capture(ms), reference_type: "TRANSACTION_ID" },
    });
    const b = res.body ?? {};
    // VERIFY in the sandbox spike: the response shape is not documented in the guide.
    return { paypalId: (b.item_id ?? b.payout_item_id ?? b.payout_transaction_id ?? b.reference_id ?? this.capture(ms)) as string };
  }

  async refundMilestone(job: RailJob, ms: RailMilestone, ctx: MoneyContext): Promise<MoneyResult> {
    const res = await this.pp.post<Json>(`/v2/payments/captures/${encodeURIComponent(this.capture(ms))}/refund`, {
      requestId: ctx.requestId,
      authAssertionPayerId: this.worker(job),
      body: {
        custom_id: ctx.certificateHash,
        invoice_id: invoice(job, `m${ms.position + 1}-refund`),
        note_to_payer: proofNote(`milestone ${ms.position + 1} failed verification and is refunded`, ctx.certificateHash),
      },
    });
    return { paypalId: res.body.id as string };
  }

  async status(job: RailJob): Promise<RailStatus> {
    if (!job.paypalOrderId) return { orderStatus: "NONE", heldCents: 0, releasedCents: 0, refundedCents: 0 };
    const order = await this.order(job.paypalOrderId);
    let captured = 0;
    let refunded = 0;
    for (const pu of order.purchase_units ?? []) {
      for (const c of pu.payments?.captures ?? []) if (c.status === "COMPLETED" || c.status === "PARTIALLY_REFUNDED" || c.status === "REFUNDED") captured += toCents(c.amount);
      for (const r of pu.payments?.refunds ?? []) if (r.status === "COMPLETED") refunded += toCents(r.amount);
    }
    // Whether held funds were disbursed is not on the order; settlement records our release IDs.
    return { orderStatus: String(order.status), heldCents: captured - refunded, releasedCents: 0, refundedCents: refunded, captures: capturesOf(order), raw: order };
  }
}

export function paypalRail(name: PaymentRail["name"], pp: PayPalClient, opts: PayPalRailOptions): PaymentRail {
  return name === "auth_capture" ? new AuthCaptureRail(pp, opts) : new DelayedDisbursementRail(pp, opts);
}
