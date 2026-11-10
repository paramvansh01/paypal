/**
 * npm run demo:verify -- [--runs N] [--sites good,flawed,sneaky]
 *
 * Runs the full verifier quorum (local Chromium, Chromium, WebKit) against the
 * demo sites N times each and checks every run gives the expected result:
 *   good   → 4 of 4 milestones pass
 *   flawed → 3 of 4 (contact form fails on quorum)
 *   sneaky → 3 of 4 (contact form fails on injection, INJECTION_DETECTED)
 * Uses a throwaway database and keys. Exits non-zero on any mismatch.
 */
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/client.js";
import { seedDemoParties } from "../src/db/seed.js";
import { createDeliveredDemoJob } from "../src/demo/job.js";
import { loadKeyring } from "../src/qaps/keys.js";
import { verifierIds } from "../src/qaps/protocol.js";
import { createApp } from "../src/server/app.js";
import { panelBrowsers } from "../src/verifier/browser.js";
import { EvidenceStore } from "../src/verifier/evidence-store.js";
import { verifyJob } from "../src/verifier/orchestrator.js";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : fallback;
};
const runs = Number(arg("runs", "3"));
const sites = arg("sites", "good,flawed,sneaky").split(",");
const EXPECT: Record<string, { passed: number; formReason: string; injection: boolean }> = {
  good: { passed: 4, formReason: "quorum", injection: false },
  flawed: { passed: 3, formReason: "quorum", injection: false },
  sneaky: { passed: 3, formReason: "injection", injection: true },
};

const config = loadConfig();
const server = createApp(config).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const db = openDb(":memory:");
seedDemoParties(db, loadConfig({ DEMO_CLIENT_EMAIL: "client@example.com", DEMO_WORKER_EMAIL: "worker@example.com" }));
const keyring = loadKeyring(verifierIds(3), { dir: mkdtempSync(join(tmpdir(), "kept-demo-keys-")) });
const store = new EvidenceStore(mkdtempSync(join(tmpdir(), "kept-demo-ev-")));

let failures = 0;
console.log(`Verifying ${sites.join(", ")} × ${runs} with a 2-of-3 quorum (local Chromium, Chromium, WebKit)\n`);
for (const site of sites) {
  for (let run = 1; run <= runs; run++) {
    const started = Date.now();
    const jobId = createDeliveredDemoJob(db, { keyring, deliverableUrl: `${origin}/demo/sites/${site}/` });
    const s = await verifyJob(db, jobId, {
      keyring,
      store,
      network: { allowOrigins: [origin] },
      panel: (ids, url) => panelBrowsers(ids, { preferKernel: false, deliverableUrl: url }),
      judgeModels: config.verifier.judgeModels,
      checkTimeoutMs: config.verifier.checkTimeoutMs,
    });
    const passed = s.outcomes?.filter((o) => o === "passed").length ?? 0;
    const form = s.items?.find((x) => x.m === 2);
    const want = EXPECT[site]!;
    const ok =
      s.status === "verified" &&
      passed === want.passed &&
      (want.passed === 4 ? form?.verdict === "pass" : form?.reason === want.formReason) &&
      (s.injectionItems.length > 0) === want.injection;
    if (!ok) failures++;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${site.padEnd(7)} run ${String(run).padStart(2)}  ${passed}/4 milestones  ` +
        `form: ${form?.verdict}/${form?.reason}  injection flags: ${s.injectionItems.map((x) => x.flags).join(",") || "-"}  ` +
        `${((Date.now() - started) / 1000).toFixed(1)} s`,
    );
  }
}
server.close();
console.log(failures ? `\n${failures} run(s) did not match.` : `\nAll ${runs * sites.length} runs matched.`);
process.exit(failures ? 1 : 0);
