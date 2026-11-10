/**
 * npm run demo:report -- [--site good|flawed|sneaky] [--port 3100]
 *
 * Starts a throwaway Kept server, runs the real verifier quorum (local
 * Chromium, Chromium, WebKit) on one demo site, settles it on an OFFLINE
 * stand-in for PayPal (no money, IDs start with OFFLINE-), and prints the
 * evidence report URL. Keeps serving until Ctrl+C. Needs no keys.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { loadProofFromDb, recordClientDecision } from "../src/core/proof-store.js";
import { settleJob } from "../src/core/settlement.js";
import { openDb } from "../src/db/client.js";
import { DEMO_CLIENT_ID, seedDemoParties } from "../src/db/seed.js";
import { createDeliveredDemoJob } from "../src/demo/job.js";
import { loadKeyring } from "../src/qaps/keys.js";
import { verifierIds } from "../src/qaps/protocol.js";
import { ISSUER_ID } from "../src/qaps/receipt.js";
import type { PaymentRail } from "../src/rails/types.js";
import { createApp } from "../src/server/app.js";
import { buildVerifier } from "../src/server/verifier.js";
import { EvidenceStore } from "../src/verifier/evidence-store.js";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : fallback;
};
const site = arg("site", "sneaky");
const port = Number(arg("port", "3100"));
if (!["good", "flawed", "sneaky"].includes(site)) {
  console.error("--site must be good, flawed or sneaky");
  process.exit(2);
}

/** No PayPal: records what would happen. Every ID says OFFLINE so nobody mistakes it for a real payment. */
const offlineRail: PaymentRail = {
  name: "auth_capture",
  lock: async () => ({ orderId: "OFFLINE-ORDER", approveUrl: "about:blank" }),
  confirmLocked: async () => ({ captureIds: ["OFFLINE-CAPTURE"] }),
  releaseMilestone: async (_j, ms) => ({ paypalId: `OFFLINE-RELEASE-${ms.position + 1}` }),
  refundMilestone: async (_j, ms) => ({ paypalId: `OFFLINE-REFUND-${ms.position + 1}` }),
  status: async () => ({ orderStatus: "OFFLINE", heldCents: 0, releasedCents: 0, refundedCents: 0 }),
};

const tmp = mkdtempSync(join(tmpdir(), "kept-demo-report-"));
const base = `http://127.0.0.1:${port}`;
const config = loadConfig({ ...process.env, PORT: String(port), PUBLIC_BASE_URL: base, DEMO_CLIENT_EMAIL: "client@example.com", DEMO_WORKER_EMAIL: "worker@example.com" });
const db = openDb(join(tmp, "kept.db"));
seedDemoParties(db, config);
const keyring = loadKeyring(verifierIds(3), { dir: join(tmp, "keys") });
const issuer = loadKeyring([ISSUER_ID], { dir: join(tmp, "keys") }).get(ISSUER_ID)!;
const evidence = new EvidenceStore(join(tmp, "evidence"));
const verify = buildVerifier(config, keyring, evidence);
const app = createApp(config, { db, keyring, issuer, evidence, rail: offlineRail, verify });
await new Promise<void>((r) => app.listen(port, "127.0.0.1", () => r()));

const jobId = createDeliveredDemoJob(db, { keyring, deliverableUrl: `${base}/demo/sites/${site}/`, title: `Halcyon Crumb website (${site} delivery)` });
console.log(`Verifying ${site} with 3 verifiers…`);
const summary = await verify(db, jobId);
for (const item of summary.items?.filter((x) => x.verdict === "needs_client") ?? []) {
  recordClientDecision(db, { jobId, m: item.m, i: item.i, decision: "approve", actor: DEMO_CLIENT_ID, note: "Looks good to me" });
}
const report = await settleJob(db, jobId, { rail: offlineRail, loadProof: loadProofFromDb, actor: "kept" });
console.log(`Settled offline: released $${report.releasedCents / 100}, refunded $${report.refundedCents / 100}`);
console.log(`\nEvidence report: ${base}/jobs/${jobId}/report`);
console.log(`Proof Receipt:   ${base}/jobs/${jobId}/receipt\n(Ctrl+C to stop)`);
