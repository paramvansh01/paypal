/**
 * P1 spike: npm run spike:rail -- --rail auth_capture|delayed_disbursement [--write]
 *
 * Runs one rail end to end against the PayPal SANDBOX with a $4.00 test job of
 * four $1.00 milestones: create the order, pause for a person to approve it with
 * the sandbox buyer account, confirm, release milestones 1, 2 and 4, refund 3,
 * finalize, then read the order back from PayPal. Prints every PayPal ID and
 * status; with --write it appends the run to docs/SPIKE_RESULTS.md (no secrets).
 *
 * Then check the balances by hand in the sandbox accounts (buyer and worker):
 * the decision rule in CLAUDE.md T1.6 needs the worker's balance to actually move.
 */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../src/config.js";
import { paypalFromConfig } from "../src/paypal/index.js";
import { paypalRail } from "../src/rails/paypal.js";
import type { RailJob } from "../src/rails/types.js";

const argv = process.argv;
const railName = (argv[argv.indexOf("--rail") + 1] ?? "auth_capture") as "auth_capture" | "delayed_disbursement";
if (!["auth_capture", "delayed_disbursement"].includes(railName)) {
  console.error("usage: npm run spike:rail -- --rail auth_capture|delayed_disbursement [--write]");
  process.exit(2);
}
const config = loadConfig({ ...process.env, PAYMENT_RAIL: railName });
const pp = paypalFromConfig(config);
const rail = paypalRail(railName, pp, { publicBaseUrl: config.app.publicBaseUrl });
const stamp = new Date().toISOString();
const id = `spike_${Date.now().toString(36)}`;
const job: RailJob = {
  id,
  currency: "USD",
  totalCents: 400,
  contractHash: "0".repeat(64),
  paypalOrderId: null,
  workerMerchantId: config.demo.workerMerchantId ?? null,
  milestones: [0, 1, 2, 3].map((p) => ({ id: `${id}_m${p}`, position: p, title: `Spike milestone ${p + 1}`, amountCents: 100, paypalCaptureId: null })),
};
const log: string[] = [`## ${stamp} — rail ${railName} (spike-rail.ts)`, ""];
const say = (line: string) => {
  console.log(line);
  log.push(`- ${line}`);
};

const lock = await rail.lock(job, { requestId: `${id}:lock` });
job.paypalOrderId = lock.orderId;
say(`Order ${lock.orderId} created (custom_id = contract hash).`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question(`\nApprove with the sandbox BUYER account:\n\n  ${lock.approveUrl}\n\nthen press Enter. `);
rl.close();

const conf = await rail.confirmLocked(job, { requestId: `${id}:confirm` });
say(`Confirmed: captures [${conf.captureIds.join(", ")}]${conf.authorizationId ? `, authorization ${conf.authorizationId}` : ""}.`);
job.milestones.forEach((m, i) => (m.paypalCaptureId = conf.captureIds.length === 4 ? conf.captureIds[i]! : (conf.captureIds[0] ?? null)));
const cert = "c".repeat(64);
for (const m of job.milestones) {
  const action = m.position === 2 ? "refund" : "release";
  const ctx = { requestId: `${id}:${m.id}:${action}`, certificateHash: cert };
  const r = action === "release" ? await rail.releaseMilestone(job, m, ctx) : await rail.refundMilestone(job, m, ctx);
  say(`Milestone ${m.position + 1}: ${action} → ${r.paypalId ?? "(nothing to move)"}`);
}
if (rail.finalize) say(`Finalize → ${(await rail.finalize(job, { requestId: `${id}:finalize`, certificateHash: cert })).paypalId ?? "(nothing to do)"}`);
const s = await rail.status(job);
say(`PayPal reports: order ${s.orderStatus}, held ${s.heldCents}¢, released ${s.releasedCents}¢, refunded ${s.refundedCents}¢.`);
say("NOW CHECK BY HAND: buyer and worker sandbox balances (expected: worker +$3.00 gross minus fees, buyer charged $3.00 net).");
if (argv.includes("--write")) {
  appendFileSync("docs/SPIKE_RESULTS.md", `\n${log.join("\n")}\n`);
  console.log("Appended to docs/SPIKE_RESULTS.md");
}
