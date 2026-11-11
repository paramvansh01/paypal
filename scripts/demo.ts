/**
 * T4.5: npm run demo -- [--site good|flawed|sneaky|all] [--runs 1] [--base <url>] [--port 3300] [--keep]
 *
 * Agent-to-agent, start to finish, entirely over MCP: the buyer agent posts a
 * job with a contract, the worker agent accepts and delivers a demo site, the
 * verifier quorum checks it, and settlement releases or refunds each milestone.
 * Prints a narration, checks the outcome against what that site must produce,
 * and saves the Proof Receipt. Exits non-zero if any run differs.
 *
 * Without --base it starts its own Kept server with throwaway data. Until the
 * PayPal rail exists (T2.3) that server uses the OFFLINE stand-in: no money
 * moves, every ID says OFFLINE, and the narration says so. With --base it
 * drives a running server (party tokens from MCP_AUTH_TOKEN in .env) and pauses
 * for the PayPal approval click.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { runBuyer } from "../agents/buyer.js";
import { arg, connectAgent, dollars, type ToolData } from "../agents/kept-agent.js";
import { DEMO_SITES, runWorker, type DemoSite } from "../agents/worker.js";
import { loadConfig } from "../src/config.js";
import { DEMO_CLIENT_ID, DEMO_WORKER_ID, seedDemoParties } from "../src/db/seed.js";
import { offlineRail } from "../src/rails/offline.js";
import { verifyReceipt } from "../src/qaps/receipt.js";
import { createApp } from "../src/server/app.js";
import { partyToken } from "../src/server/auth.js";
import { loadServices } from "../src/server/services.js";
import { readFileSync } from "node:fs";

const EXPECTED: Record<DemoSite, { outcomes: string[]; injection: boolean }> = {
  good: { outcomes: ["passed", "passed", "passed", "passed"], injection: false },
  flawed: { outcomes: ["passed", "passed", "failed", "passed"], injection: false },
  sneaky: { outcomes: ["passed", "passed", "failed", "passed"], injection: true },
};

const siteArg = arg("site", "flawed")!;
const sites: DemoSite[] = siteArg === "all" ? [...DEMO_SITES] : [siteArg as DemoSite];
const runs = Number(arg("runs", "1"));
if (!sites.every((s) => DEMO_SITES.includes(s)) || !(runs >= 1)) {
  console.error("usage: npm run demo -- [--site good|flawed|sneaky|all] [--runs N] [--base <url>] [--port 3300] [--keep]");
  process.exit(2);
}
const keep = process.argv.includes("--keep");
const contract = JSON.parse(readFileSync(new URL("../demo/contract.json", import.meta.url), "utf8")) as ToolData;

// ---- the server the agents talk to ----
let base = arg("base");
let secret: string;
let offline = false;
let stop = async () => {};
if (!base) {
  const port = Number(arg("port", "3300"));
  base = `http://127.0.0.1:${port}`;
  const tmp = mkdtempSync(join(tmpdir(), "kept-demo-"));
  secret = randomBytes(24).toString("hex");
  const config = loadConfig({
    ...process.env,
    PORT: String(port),
    PUBLIC_BASE_URL: base,
    MCP_AUTH_TOKEN: secret,
    DATABASE_PATH: join(tmp, "kept.db"),
    VERIFIER_KEYS_DIR: join(tmp, "keys"),
    EVIDENCE_DIR: join(tmp, "evidence"),
    VERIFIER_KEYS_JSON: "",
    DEMO_CLIENT_EMAIL: process.env.DEMO_CLIENT_EMAIL || "client@example.com",
    DEMO_WORKER_EMAIL: process.env.DEMO_WORKER_EMAIL || "worker@example.com",
  });
  const services = loadServices(config);
  seedDemoParties(services.db, config);
  // The PayPal sandbox rail when PayPal keys are configured; otherwise the OFFLINE stand-in.
  const rail = services.rail ?? offlineRail();
  offline = !services.rail;
  const app = createApp(config, { ...services, rail });
  const server = await new Promise<import("node:http").Server>((r) => {
    const s = app.listen(port, "127.0.0.1", () => r(s));
  });
  stop = () => new Promise((r) => server.close(() => r()));
} else {
  const config = loadConfig();
  if (!config.app.mcpAuthToken) {
    console.error("--base needs MCP_AUTH_TOKEN in .env (the same one the server uses), to make the party tokens.");
    process.exit(2);
  }
  secret = config.app.mcpAuthToken;
}

const narrate = (who: string) => (line: string) => console.log(`${who.padEnd(8)} ${line}`);
const kept = narrate("[kept]");
kept(`Server: ${base}`);
if (offline) {
  kept("PayPal: OFFLINE stand-in (the sandbox rail is not connected yet). No money moves; every payment ID starts with OFFLINE-.");
}

const rl = offline ? undefined : createInterface({ input: process.stdin, output: process.stdout });
const receiptsDir = join("data", "demo-receipts");
mkdirSync(receiptsDir, { recursive: true });
const failures: string[] = [];

for (const site of sites) {
  for (let n = 1; n <= runs; n++) {
    console.log(`\n=== ${site} delivery${runs > 1 ? `, run ${n} of ${runs}` : ""} ===`);
    const buyer = await connectAgent(base, partyToken(secret, DEMO_CLIENT_ID), "buyer");
    const worker = await connectAgent(base, partyToken(secret, DEMO_WORKER_ID), "worker");
    const stopWorker = new AbortController();
    const workerRun = runWorker(worker, { deliverableBase: base, site, signal: stopWorker.signal, pollMs: 300, log: narrate("[worker]") });
    try {
      const r = await runBuyer(buyer, {
        goal: "Halcyon Crumb bakery website: home page, menu, a working contact form, mobile friendly and fast",
        title: `Halcyon Crumb website (${site} delivery)`,
        budgetCents: contract.total_cents,
        workerId: DEMO_WORKER_ID,
        checklist: contract,
        pollMs: 300,
        log: narrate("[buyer]"),
        onApproval: async (url) => {
          if (offline) {
            kept("OFFLINE: no PayPal approval page. With the sandbox rail a person approves the payment here, once.");
            return;
          }
          await rl!.question(`\n  Approve the payment in PayPal (sandbox buyer account):\n\n    ${url}\n\n  then press Enter. `);
        },
      });
      const file = join(receiptsDir, `kept-receipt-${r.jobId}.json`);
      writeFileSync(file, JSON.stringify(r.receipt, null, 2));
      const check = verifyReceipt(r.receipt);
      const outcomes = r.verification.milestone_outcomes as string[];
      const injected = (r.verification.injection_attempts as unknown[]).length > 0;
      const want = EXPECTED[site];
      const problems = [
        outcomes.join() !== want.outcomes.join() && `outcomes ${outcomes.join(", ")}, expected ${want.outcomes.join(", ")}`,
        injected !== want.injection && `injection detected: ${injected}, expected ${want.injection}`,
        !check.ok && `receipt does not verify: ${check.checks.filter((c) => !c.ok).map((c) => c.check).join(", ")}`,
      ].filter(Boolean) as string[];
      kept(`Proof Receipt: ${file} (${check.ok ? "verifies" : "DOES NOT VERIFY"}). Check it yourself: node tools/verify-receipt.mjs ${file}`);
      kept(`Evidence report: ${base}/jobs/${r.jobId}/report`);
      kept(`Result: ${dollars(r.settlement.releasedCents)} to the worker, ${dollars(r.settlement.refundedCents)} back to the client. ${problems.length ? `UNEXPECTED: ${problems.join("; ")}` : "As expected."}`);
      for (const p of problems) failures.push(`${site} run ${n}: ${p}`);
    } catch (err) {
      failures.push(`${site} run ${n}: ${err instanceof Error ? err.message : String(err)}`);
      kept(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      stopWorker.abort();
      await workerRun.catch(() => {});
      await buyer.close();
      await worker.close();
    }
  }
}

rl?.close();
console.log(failures.length ? `\n${failures.length} run(s) did not go as expected:\n  ${failures.join("\n  ")}` : `\nAll ${sites.length * runs} run(s) went as expected.`);
if (keep && offline) {
  kept(`Still serving ${base} (reports stay viewable). Ctrl+C to stop.`);
} else {
  await stop();
  process.exit(failures.length ? 1 : 0);
}
