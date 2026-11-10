import { createHash } from "node:crypto";
import { requestAccessToken } from "./token.js";

/**
 * Thin PayPal REST client: cached OAuth token, idempotency header, safe
 * retries, and errors that keep PayPal's debug_id.
 * Docs: developer.paypal.com/api/rest/requests, /responses, /authentication.
 */

export interface PayPalClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** BN code sent as PayPal-Partner-Attribution-Id on every call, if set. */
  partnerAttributionId?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Retries for 429, 5xx and network errors. Only used when the call is safe to repeat. */
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

export interface RequestOptions {
  body?: unknown;
  /** Idempotency key. Required for POSTs to be retried. Use `paypalRequestId()`. */
  requestId?: string;
  /** Merchant to act for (delayed disbursement calls on a seller's behalf). */
  authAssertionPayerId?: string;
  headers?: Record<string, string>;
}

export interface PayPalResponse<T> {
  status: number;
  body: T;
  debugId?: string;
}

export interface PayPalErrorDetail {
  field?: string;
  value?: string;
  location?: string;
  issue?: string;
  description?: string;
}

export class PayPalApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly errorName: string | undefined,
    readonly debugId: string | undefined,
    readonly details: PayPalErrorDetail[],
    readonly body: unknown,
  ) {
    const issues = details.map((d) => d.issue).filter(Boolean);
    super(
      `PayPal ${method} ${path} failed (${status}${errorName ? ` ${errorName}` : ""})` +
        `${issues.length ? `: ${issues.join(", ")}` : ""}${debugId ? ` [debug_id ${debugId}]` : ""}`,
    );
    this.name = "PayPalApiError";
  }
}

/** Refresh this long before PayPal's stated expiry, to avoid using a token that dies in flight. */
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60_000;

export class PayPalClient {
  private token?: { value: string; expiresAt: number };
  private inflight?: Promise<string>;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  /** Number of token requests made; exposed for tests and the doctor. */
  tokenRequests = 0;

  constructor(private readonly opts: PayPalClientOptions) {
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async getAccessToken(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt) return this.token.value;
    // Share one in-flight request between concurrent callers.
    this.inflight ??= (async () => {
      try {
        this.tokenRequests++;
        const t = await requestAccessToken(
          this.opts.baseUrl,
          this.opts.clientId,
          this.opts.clientSecret,
          undefined,
          this.fetch,
        );
        const lifetimeMs = Math.max(0, t.expires_in * 1000 - TOKEN_EXPIRY_MARGIN_MS);
        this.token = { value: t.access_token, expiresAt: this.now() + lifetimeMs };
        return t.access_token;
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  invalidateToken(): void {
    this.token = undefined;
  }

  get<T>(path: string, opts: RequestOptions = {}) {
    return this.request<T>("GET", path, opts);
  }
  post<T>(path: string, opts: RequestOptions = {}) {
    return this.request<T>("POST", path, opts);
  }
  patch<T>(path: string, opts: RequestOptions = {}) {
    return this.request<T>("PATCH", path, opts);
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<PayPalResponse<T>> {
    const maxRetries = this.opts.maxRetries ?? 2;
    // A POST/PATCH without an idempotency key might move money twice if repeated, so never retry it.
    const retryable = method === "GET" || Boolean(opts.requestId);
    let refreshedToken = false;

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetch(`${this.opts.baseUrl}${path}`, {
          method,
          headers: await this.headers(opts),
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
        });
      } catch (err) {
        if (retryable && attempt < maxRetries) {
          await this.sleep(attempt);
          continue;
        }
        throw err;
      }

      const debugId = res.headers.get("paypal-debug-id") ?? undefined;
      const text = await res.text();
      const body: unknown = text ? safeJson(text) : undefined;

      if (res.ok) return { status: res.status, body: body as T, debugId };

      if (res.status === 401 && !refreshedToken) {
        refreshedToken = true;
        this.invalidateToken();
        attempt--; // a token refresh is not a retry
        continue;
      }
      if (retryable && (res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        await this.sleep(attempt);
        continue;
      }
      throw toApiError(method, path, res.status, body, debugId);
    }
  }

  private async headers(opts: RequestOptions): Promise<Record<string, string>> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${await this.getAccessToken()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      Prefer: "return=representation",
    };
    if (opts.requestId) h["PayPal-Request-Id"] = opts.requestId;
    if (this.opts.partnerAttributionId) h["PayPal-Partner-Attribution-Id"] = this.opts.partnerAttributionId;
    if (opts.authAssertionPayerId) {
      h["PayPal-Auth-Assertion"] = authAssertion(this.opts.clientId, opts.authAssertionPayerId);
    }
    return { ...h, ...opts.headers };
  }

  private sleep(attempt: number): Promise<void> {
    const ms = (this.opts.retryDelayMs ?? 500) * 2 ** attempt;
    return new Promise((r) => setTimeout(r, ms));
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toApiError(method: string, path: string, status: number, body: unknown, headerDebugId?: string) {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const details = Array.isArray(b.details) ? (b.details as PayPalErrorDetail[]) : [];
  const name = typeof b.name === "string" ? b.name : typeof b.error === "string" ? b.error : undefined;
  const debugId = typeof b.debug_id === "string" ? b.debug_id : headerDebugId;
  return new PayPalApiError(method, path, status, name, debugId, details, body);
}

/**
 * Deterministic idempotency key: the same job + milestone + action always gives
 * the same ID, so a retry or a second `settle` can never pay twice.
 */
export function paypalRequestId(jobId: string, milestoneId: string | null, action: string): string {
  const raw = `kept:${jobId}:${milestoneId ?? "job"}:${action}`;
  if (raw.length <= 64) return raw;
  return `kept:${createHash("sha256").update(raw).digest("hex").slice(0, 48)}`;
}

/**
 * Unsigned JWT that tells PayPal which merchant a partner call is for.
 * VERIFY against the delayed-disbursement docs in T1.4 before relying on it.
 */
export function authAssertion(clientId: string, payerId: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ iss: clientId, payer_id: payerId })}.`;
}
