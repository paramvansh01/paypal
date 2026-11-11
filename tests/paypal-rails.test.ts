import { describe, expect, it } from "vitest";
import { PayPalClient } from "../src/paypal/client.js";
import { approveLink, AuthCaptureRail, DelayedDisbursementRail, money } from "../src/rails/paypal.js";
import type { RailJob } from "../src/rails/types.js";

/**
 * A small in-memory PayPal: enough of Orders v2 / Payments v2 / referenced payouts
 * to drive both rails, and a record of every request so the tests can check
 * paths, headers and bodies against the published schemas.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Json | undefined;
}

function fakePayPal() {
  const calls: Call[] = [];
  const orders = new Map<string, Json>();
  const auths = new Map<string, Json>();
  let n = 0;
  const id = (p: string) => `${p}${++n}`;
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "paypal-debug-id": "dbg" } });

  const fetchFn = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const path = u.pathname;
    const method = init?.method ?? "GET";
    if (path === "/v1/oauth2/token") return reply(200, { access_token: "tok", token_type: "Bearer", expires_in: 32400 });
    const body = init?.body ? (JSON.parse(String(init.body)) as Json) : undefined;
    calls.push({ method, path, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body });

    let m: RegExpMatchArray | null;
    if (method === "POST" && path === "/v2/checkout/orders") {
      const o = { id: id("ORDER-"), status: "PAYER_ACTION_REQUIRED", intent: body!.intent, purchase_units: body!.purchase_units.map((pu: Json) => ({ ...pu, payments: {} })), links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=T" }] };
      orders.set(o.id, o);
      return reply(201, o);
    }
    if (method === "GET" && (m = path.match(/^\/v2\/checkout\/orders\/([^/]+)$/))) return orders.has(m[1]!) ? reply(200, orders.get(m[1]!)) : reply(404, { name: "RESOURCE_NOT_FOUND" });
    if (method === "POST" && (m = path.match(/^\/v2\/checkout\/orders\/([^/]+)\/(authorize|capture)$/)) && !orders.has(m[1]!)) {
      return reply(404, { name: "RESOURCE_NOT_FOUND", debug_id: "dbg", details: [{ issue: "INVALID_RESOURCE_ID" }] });
    }
    if (method === "POST" && (m = path.match(/^\/v2\/checkout\/orders\/([^/]+)\/authorize$/))) {
      const o = orders.get(m[1]!)!;
      const a = { id: id("AUTH-"), status: "CREATED", amount: o.purchase_units[0].amount };
      auths.set(a.id, a);
      o.status = "COMPLETED";
      o.purchase_units[0].payments = { authorizations: [a], captures: [] };
      return reply(201, o);
    }
    if (method === "POST" && (m = path.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/))) {
      const o = orders.get(m[1]!)!;
      o.status = "COMPLETED";
      for (const pu of o.purchase_units) pu.payments = { captures: [{ id: id("CAP-"), status: "COMPLETED", amount: pu.amount }], refunds: [] };
      return reply(201, o);
    }
    if (method === "GET" && (m = path.match(/^\/v2\/payments\/authorizations\/([^/]+)$/))) return reply(200, auths.get(m[1]!));
    if (method === "POST" && (m = path.match(/^\/v2\/payments\/authorizations\/([^/]+)\/capture$/))) {
      const a = auths.get(m[1]!)!;
      const o = [...orders.values()].find((x) => x.purchase_units[0].payments?.authorizations?.[0]?.id === a.id)!;
      const cap = { id: id("CAP-"), status: "COMPLETED", amount: body!.amount, invoice_id: body!.invoice_id };
      o.purchase_units[0].payments.captures.push(cap);
      const captured = o.purchase_units[0].payments.captures.reduce((s: number, c: Json) => s + Number(c.amount.value), 0);
      a.status = captured >= Number(a.amount.value) ? "CAPTURED" : "PARTIALLY_CAPTURED";
      return reply(201, cap);
    }
    if (method === "POST" && (m = path.match(/^\/v2\/payments\/authorizations\/([^/]+)\/void$/))) {
      const a = auths.get(m[1]!)!;
      if (a.status === "CAPTURED") return reply(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "AUTHORIZATION_ALREADY_CAPTURED" }] });
      a.status = "VOIDED";
      return reply(200, a);
    }
    if (method === "POST" && path === "/v1/payments/referenced-payouts-items") return reply(200, { item_id: id("PAYOUT-"), reference_id: body!.reference_id, processing_state: { status: "PENDING" } });
    if (method === "POST" && (m = path.match(/^\/v2\/payments\/captures\/([^/]+)\/refund$/))) {
      const r = { id: id("REFUND-"), status: "COMPLETED" };
      for (const o of orders.values()) for (const pu of o.purchase_units) if (pu.payments?.captures?.some((c: Json) => c.id === m![1])) pu.payments.refunds.push({ ...r, amount: pu.amount });
      return reply(201, r);
    }
    return reply(404, { name: "NOT_FOUND", path });
  };
  const client = new PayPalClient({ baseUrl: "https://api-m.sandbox.paypal.com", clientId: "CID", clientSecret: "SECRET", partnerAttributionId: "BN-CODE", fetch: fetchFn as typeof fetch, retryDelayMs: 1 });
  return { client, calls, orders, auths };
}

const HASH = "a".repeat(64);
const CERT = "c".repeat(64);
function job(over: Partial<RailJob> = {}): RailJob {
  return {
    id: "job_abc",
    currency: "USD",
    totalCents: 10000,
    contractHash: HASH,
    paypalOrderId: null,
    workerMerchantId: "WORKERMID",
    milestones: [0, 1, 2, 3].map((p) => ({ id: `ms_${p}`, position: p, title: `Milestone ${p + 1}`, amountCents: 2500, paypalCaptureId: null })),
    ...over,
  };
}
const opts = { publicBaseUrl: "https://kept.example" };

describe("PayPal helpers", () => {
  it("formats money as PayPal wants it and finds the approval link", () => {
    expect(money(2500, "USD")).toEqual({ currency_code: "USD", value: "25.00" });
    expect(money(1, "USD").value).toBe("0.01");
    expect(approveLink({ id: "O", links: [{ rel: "self", href: "x" }, { rel: "approve", href: "https://p/a" }] })).toBe("https://p/a");
    expect(() => approveLink({ id: "O", links: [] })).toThrow(/no approval link/);
  });
});

describe("auth_capture rail", () => {
  it("authorizes the budget, captures passed milestones with the proof on them, voids the rest", async () => {
    const pp = fakePayPal();
    const rail = new AuthCaptureRail(pp.client, opts);
    const j = job();

    const lock = await rail.lock(j, { requestId: "kept:job_abc:job:lock" });
    expect(lock.approveUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
    const create = pp.calls[0]!;
    expect(create.headers["PayPal-Request-Id"]).toBe("kept:job_abc:job:lock");
    expect(create.headers["PayPal-Partner-Attribution-Id"]).toBe("BN-CODE");
    expect(create.body).toMatchObject({
      intent: "AUTHORIZE",
      purchase_units: [{ reference_id: "job_abc", custom_id: HASH, invoice_id: "kept-job_abc-order", amount: { currency_code: "USD", value: "100.00" } }],
      payment_source: { paypal: { experience_context: { shipping_preference: "NO_SHIPPING", return_url: "https://kept.example/app/jobs/job_abc?paypal=approved" } } },
    });
    expect(create.body!.purchase_units[0].description.length).toBeLessThanOrEqual(127);

    j.paypalOrderId = lock.orderId;
    // Locking again returns the same order instead of creating a second one.
    expect((await rail.lock(j, { requestId: "x" })).orderId).toBe(lock.orderId);
    expect(pp.calls.filter((c) => c.method === "POST" && c.path === "/v2/checkout/orders")).toHaveLength(1);

    const conf = await rail.confirmLocked(j, { requestId: "kept:job_abc:job:confirm" });
    expect(conf.authorizationId).toMatch(/^AUTH-/);
    expect(conf.captureIds).toEqual([]);

    const ctx = (p: number, a: string) => ({ requestId: `kept:job_abc:ms_${p}:${a}`, certificateHash: CERT });
    const r1 = await rail.releaseMilestone(j, j.milestones[0]!, ctx(0, "release"));
    expect(r1.paypalId).toMatch(/^CAP-/);
    const cap = pp.calls.find((c) => c.path.endsWith("/capture") && c.path.includes("authorizations"))!;
    expect(cap.body).toEqual({ amount: { currency_code: "USD", value: "25.00" }, final_capture: false, invoice_id: "kept-job_abc-m1", note_to_payer: `Kept: milestone 1 passed verification. Proof certificate ${CERT}` });
    expect(cap.body!.note_to_payer.length).toBeLessThanOrEqual(255);
    expect(cap.headers["PayPal-Request-Id"]).toBe("kept:job_abc:ms_0:release");
    await rail.releaseMilestone(j, j.milestones[1]!, ctx(1, "release"));
    expect(await rail.refundMilestone()).toEqual({ paypalId: null });
    await rail.releaseMilestone(j, j.milestones[3]!, ctx(3, "release"));

    const fin = await rail.finalize(j);
    expect(fin.paypalId).toBe(conf.authorizationId);
    expect(pp.calls.some((c) => c.path.endsWith("/void"))).toBe(true);
    expect(await rail.finalize(j)).toEqual({ paypalId: null }); // already voided: nothing to do

    const s = await rail.status(j);
    expect(s).toMatchObject({ heldCents: 0, releasedCents: 7500, refundedCents: 2500 });
  });

  it("does not try to void a fully captured authorization", async () => {
    const pp = fakePayPal();
    const rail = new AuthCaptureRail(pp.client, opts);
    const j = job();
    j.paypalOrderId = (await rail.lock(j, { requestId: "l" })).orderId;
    await rail.confirmLocked(j, { requestId: "c" });
    for (const ms of j.milestones) await rail.releaseMilestone(j, ms, { requestId: ms.id, certificateHash: CERT });
    expect(await rail.finalize(j)).toEqual({ paypalId: null });
    expect(pp.calls.some((c) => c.path.endsWith("/void"))).toBe(false);
    expect(await rail.status(j)).toMatchObject({ heldCents: 0, releasedCents: 10000, refundedCents: 0 });
  });

  it("keeps PayPal's debug_id on errors", async () => {
    const pp = fakePayPal();
    const rail = new AuthCaptureRail(pp.client, opts);
    await expect(rail.confirmLocked(job({ paypalOrderId: "ORDER-NOPE" }), { requestId: "c" })).rejects.toThrow(/debug_id dbg/);
  });
});

describe("delayed_disbursement rail", () => {
  it("one purchase unit per milestone paying the worker, DELAYED; release via referenced payouts; refund on the seller's behalf", async () => {
    const pp = fakePayPal();
    const rail = new DelayedDisbursementRail(pp.client, opts);
    const j = job();
    const lock = await rail.lock(j, { requestId: "kept:job_abc:job:lock" });
    const body = pp.calls[0]!.body!;
    expect(body.intent).toBe("CAPTURE");
    expect(body.purchase_units).toHaveLength(4);
    expect(body.purchase_units[2]).toMatchObject({
      reference_id: "ms_2",
      custom_id: HASH,
      invoice_id: "kept-job_abc-m3",
      amount: { currency_code: "USD", value: "25.00" },
      payee: { merchant_id: "WORKERMID" },
      payment_instruction: { disbursement_mode: "DELAYED" },
    });

    j.paypalOrderId = lock.orderId;
    const conf = await rail.confirmLocked(j, { requestId: "kept:job_abc:job:confirm" });
    expect(conf.captureIds).toHaveLength(4);
    j.milestones.forEach((ms, i) => (ms.paypalCaptureId = conf.captureIds[i]!));
    expect(await rail.status(j)).toMatchObject({ heldCents: 10000, refundedCents: 0 });

    const rel = await rail.releaseMilestone(j, j.milestones[0]!, { requestId: "kept:job_abc:ms_0:release", certificateHash: CERT });
    expect(rel.paypalId).toMatch(/^PAYOUT-/);
    const payout = pp.calls.find((c) => c.path === "/v1/payments/referenced-payouts-items")!;
    expect(payout.body).toEqual({ reference_id: conf.captureIds[0], reference_type: "TRANSACTION_ID" });
    expect(payout.headers["PayPal-Request-Id"]).toBe("kept:job_abc:ms_0:release");

    const ref = await rail.refundMilestone(j, j.milestones[2]!, { requestId: "kept:job_abc:ms_2:refund", certificateHash: CERT });
    expect(ref.paypalId).toMatch(/^REFUND-/);
    const refund = pp.calls.find((c) => c.path.endsWith("/refund"))!;
    expect(refund.path).toBe(`/v2/payments/captures/${conf.captureIds[2]}/refund`);
    expect(refund.body).toMatchObject({ custom_id: CERT, invoice_id: "kept-job_abc-m3-refund" });
    expect(refund.headers["PayPal-Auth-Assertion"]).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.$/);
    const payload = JSON.parse(Buffer.from(refund.headers["PayPal-Auth-Assertion"]!.split(".")[1]!, "base64url").toString());
    expect(payload).toEqual({ iss: "CID", payer_id: "WORKERMID" });
    expect(await rail.status(j)).toMatchObject({ heldCents: 7500, refundedCents: 2500 });
  });

  it("refuses to create an order for a worker who is not onboarded", async () => {
    const rail = new DelayedDisbursementRail(fakePayPal().client, opts);
    await expect(rail.lock(job({ workerMerchantId: null }), { requestId: "l" })).rejects.toThrow(/no PayPal merchant ID/);
  });
});
