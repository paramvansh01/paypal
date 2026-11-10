import { describe, expect, it, vi } from "vitest";
import { authAssertion, PayPalApiError, PayPalClient, paypalRequestId } from "../src/paypal/client.js";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function mockFetch(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const tokenResponse = (token = "tok-1", expiresIn = 32400) =>
  json(200, { access_token: token, token_type: "Bearer", expires_in: expiresIn });

const isToken = (url: string) => url.endsWith("/v1/oauth2/token");

function client(handler: Handler, extra: { now?: () => number; partnerAttributionId?: string } = {}) {
  const m = mockFetch(handler);
  const c = new PayPalClient({
    baseUrl: "https://api-m.sandbox.paypal.com",
    clientId: "cid",
    clientSecret: "secret",
    fetch: m.fetch,
    retryDelayMs: 1,
    ...extra,
  });
  return { c, calls: m.calls };
}

const header = (init: RequestInit, name: string) => (init.headers as Record<string, string>)[name];

describe("PayPalClient token", () => {
  it("reuses a cached token across requests", async () => {
    const { c, calls } = client((url) => (isToken(url) ? tokenResponse() : json(200, { id: "X" })));
    await c.get("/v2/checkout/orders/X");
    await c.get("/v2/checkout/orders/X");
    await c.getAccessToken();
    expect(c.tokenRequests).toBe(1);
    expect(calls.filter((x) => isToken(x.url))).toHaveLength(1);
    expect(header(calls[1]!.init, "Authorization")).toBe("Bearer tok-1");
  });

  it("shares one token request between concurrent callers", async () => {
    const { c } = client((url) => (isToken(url) ? tokenResponse() : json(200, {})));
    await Promise.all([c.getAccessToken(), c.getAccessToken(), c.get("/a"), c.get("/b")]);
    expect(c.tokenRequests).toBe(1);
  });

  it("fetches a new token after expiry", async () => {
    let now = 0;
    let n = 0;
    const { c } = client((url) => (isToken(url) ? tokenResponse(`tok-${++n}`, 3600) : json(200, {})), {
      now: () => now,
    });
    expect(await c.getAccessToken()).toBe("tok-1");
    now = 3600 * 1000; // past expiry (minus the safety margin)
    expect(await c.getAccessToken()).toBe("tok-2");
  });

  it("refreshes the token once on a 401", async () => {
    let n = 0;
    let apiCalls = 0;
    const { c } = client((url) => {
      if (isToken(url)) return tokenResponse(`tok-${++n}`);
      return ++apiCalls === 1 ? json(401, { name: "AUTHENTICATION_FAILURE" }) : json(200, { ok: true });
    });
    const res = await c.get<{ ok: boolean }>("/x");
    expect(res.body.ok).toBe(true);
    expect(c.tokenRequests).toBe(2);
  });
});

describe("PayPalClient requests", () => {
  it("sends idempotency, partner and auth-assertion headers", async () => {
    const { c, calls } = client((url) => (isToken(url) ? tokenResponse() : json(201, { id: "O1" })), {
      partnerAttributionId: "BN-CODE",
    });
    const res = await c.post<{ id: string }>("/v2/checkout/orders", {
      body: { intent: "CAPTURE" },
      requestId: "kept:job1:job:create",
      authAssertionPayerId: "MERCHANT1",
    });
    expect(res).toMatchObject({ status: 201, body: { id: "O1" } });
    const init = calls[1]!.init;
    expect(header(init, "PayPal-Request-Id")).toBe("kept:job1:job:create");
    expect(header(init, "PayPal-Partner-Attribution-Id")).toBe("BN-CODE");
    expect(header(init, "PayPal-Auth-Assertion")).toBe(authAssertion("cid", "MERCHANT1"));
    expect(JSON.parse(String(init.body))).toEqual({ intent: "CAPTURE" });
  });

  it("retries a 5xx POST only when it has a request ID", async () => {
    let apiCalls = 0;
    const handler: Handler = (url) => {
      if (isToken(url)) return tokenResponse();
      return ++apiCalls < 3 ? json(503, { name: "SERVICE_UNAVAILABLE" }) : json(201, { id: "C1" });
    };
    const withId = client(handler);
    await expect(withId.c.post("/capture", { requestId: "r1" })).resolves.toMatchObject({ status: 201 });
    expect(apiCalls).toBe(3);
    // The same request ID is sent on every attempt.
    const ids = withId.calls.filter((x) => !isToken(x.url)).map((x) => header(x.init, "PayPal-Request-Id"));
    expect(new Set(ids)).toEqual(new Set(["r1"]));

    apiCalls = 0;
    const withoutId = client(handler);
    await expect(withoutId.c.post("/capture")).rejects.toBeInstanceOf(PayPalApiError);
    expect(apiCalls).toBe(1);
  });

  it("keeps PayPal's debug_id and issues in the error", async () => {
    const { c } = client((url) =>
      isToken(url)
        ? tokenResponse()
        : json(
            422,
            {
              name: "UNPROCESSABLE_ENTITY",
              message: "The requested action could not be performed.",
              debug_id: "abc123",
              details: [{ issue: "ORDER_NOT_APPROVED", description: "Payer has not approved the order." }],
            },
            { "paypal-debug-id": "abc123" },
          ),
    );
    const err = await c.post("/v2/checkout/orders/O1/capture", { requestId: "r" }).catch((e) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err).toMatchObject({ status: 422, debugId: "abc123", errorName: "UNPROCESSABLE_ENTITY" });
    expect(err.message).toContain("ORDER_NOT_APPROVED");
    expect(err.message).toContain("abc123");
  });
});

describe("paypalRequestId", () => {
  it("is deterministic and short", () => {
    expect(paypalRequestId("job1", "m1", "release")).toBe("kept:job1:m1:release");
    expect(paypalRequestId("job1", null, "create")).toBe("kept:job1:job:create");
    const long = paypalRequestId("j".repeat(80), "m", "refund");
    expect(long).toBe(paypalRequestId("j".repeat(80), "m", "refund"));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).not.toBe(paypalRequestId("j".repeat(80), "m", "release"));
  });
});
