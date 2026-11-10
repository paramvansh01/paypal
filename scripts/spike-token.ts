/** T1.1 proof: fetch a real sandbox token and show the cache reuses it. */
import { ConfigError, loadConfig, requireConfig } from "../src/config.js";
import { PayPalClient } from "../src/paypal/index.js";

try {
  const config = loadConfig();
  // Only the client ID and secret are needed for a token, whatever the rail.
  requireConfig({ ...config, env: { ...config.env, PAYMENT_RAIL: "auth_capture" } }, "paypal");
  const pp = new PayPalClient({
    baseUrl: config.paypal.baseUrl,
    clientId: config.paypal.clientId!,
    clientSecret: config.paypal.clientSecret!,
  });
  const a = await pp.getAccessToken();
  const b = await pp.getAccessToken();
  console.log(`Base URL:        ${config.paypal.baseUrl}`);
  console.log(`Token:           ${a.slice(0, 8)}…${a.slice(-4)} (${a.length} chars)`);
  console.log(`Second call same: ${a === b}`);
  console.log(`Token requests:  ${pp.tokenRequests}`);
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}
