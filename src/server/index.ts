import { ConfigError, loadConfig, missingKeys } from "../config.js";
import { seedDemoParties } from "../db/seed.js";
import { KeyError } from "../qaps/keys.js";
import { recoverInterruptedVerifications } from "../verifier/orchestrator.js";
import { createApp } from "./app.js";
import { loadServices } from "./services.js";
import { offlineRail } from "../rails/offline.js";

try {
  const config = loadConfig();
  const services = loadServices(config);
  // Seed the demo parties on every boot (idempotent): hosted databases start empty after each deploy.
  if (missingKeys(config, "demo").length === 0) seedDemoParties(services.db, config);
  else if (config.app.demoMode) seedDemoParties(services.db, loadConfig({ ...process.env, DEMO_CLIENT_EMAIL: "client@example.com", DEMO_WORKER_EMAIL: "worker@example.com" }));
  const recovered = recoverInterruptedVerifications(services.db);
  if (recovered.length) console.log(`Returned ${recovered.length} interrupted verification(s) to DELIVERED: ${recovered.join(", ")}`);
  // No PayPal rail yet (T2.3): lock, confirm and settle answer 503 until it exists,
  // except in judge mode, which uses the OFFLINE stand-in (every ID says OFFLINE; no money moves).
  if (!services.rail && config.app.demoMode) {
    services.rail = offlineRail();
    console.log("DEMO_MODE: money uses the OFFLINE stand-in (no PayPal rail configured). No money moves.");
  }
  const app = createApp(config, services);
  app.listen(config.app.port, () => {
    console.log(`Kept listening on ${config.app.publicBaseUrl} (port ${config.app.port})`);
    console.log(`MCP (Streamable HTTP): ${config.app.publicBaseUrl}/mcp`);
  });
} catch (err) {
  if (err instanceof ConfigError || err instanceof KeyError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
