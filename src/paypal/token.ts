/** Raw OAuth client-credentials call. Caching and the request helper are built on this in T1.1. */
export interface PayPalToken {
  access_token: string;
  token_type: string;
  expires_in: number;
  app_id?: string;
  scope?: string;
}

export class PayPalAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly debugId?: string,
  ) {
    super(message);
    this.name = "PayPalAuthError";
  }
}

export async function requestAccessToken(
  baseUrl: string,
  clientId: string,
  clientSecret: string,
  signal?: AbortSignal,
): Promise<PayPalToken> {
  const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const debugId = res.headers.get("paypal-debug-id") ?? undefined;
    const detail = String(body.error_description ?? body.error ?? res.statusText);
    throw new PayPalAuthError(`PayPal token request failed (${res.status}): ${detail}`, res.status, debugId);
  }
  return body as unknown as PayPalToken;
}
