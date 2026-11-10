import { requireConfig, type Config } from "../config.js";
import { PayPalClient } from "./client.js";

export * from "./client.js";

/** Builds a PayPal client from config, failing with the names of any missing keys. */
export function paypalFromConfig(config: Config): PayPalClient {
  requireConfig(config, "paypal");
  return new PayPalClient({
    baseUrl: config.paypal.baseUrl,
    clientId: config.paypal.clientId!,
    clientSecret: config.paypal.clientSecret!,
    partnerAttributionId: config.paypal.partnerAttributionId,
  });
}
