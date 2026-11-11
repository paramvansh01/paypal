import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadProofFromDb } from "../src/core/proof-store.js";
import { settleJob } from "../src/core/settlement.js";
import { openDb, type Db } from "../src/db/client.js";
import { evidence, verifierRuns } from "../src/db/schema.js";
import { seedDemoParties } from "../src/db/seed.js";
import { createDeliveredDemoJob } from "../src/demo/job.js";
import { loadKeyring } from "../src/qaps/keys.js";
import { verifierIds } from "../src/qaps/protocol.js";
import { ISSUER_ID } from "../src/qaps/receipt.js";
import { createApp } from "../src/server/app.js";
import { buildVerifier } from "../src/server/verifier.js";
import { EvidenceStore } from "../src/verifier/evidence-store.js";
import { MockRail } from "./helpers/qaps.js";

let server: Server;
let base: string;
let db: Db;
let browser: Browser;
let sneakyJob: string;
let pendingJob: string;
let cleanJob: string;

beforeAll(async () => {
  const holder: { app?: ReturnType<typeof createApp> } = {};
  server = createServer((req, res) => holder.app!(req, res)).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = loadConfig({ PUBLIC_BASE_URL: base, PORT: new URL(base).port, DEMO_CLIENT_EMAIL: "c@example.com", DEMO_WORKER_EMAIL: "w@example.com" });
  db = openDb(":memory:");
  seedDemoParties(db, config);
  const keyring = loadKeyring(verifierIds(3), { dir: mkdtempSync(join(tmpdir(), "kept-rep-keys-")) });
  const issuer = loadKeyring([ISSUER_ID], { dir: mkdtempSync(join(tmpdir(), "kept-rep-iss-")) }).get(ISSUER_ID)!;
  const store = new EvidenceStore(mkdtempSync(join(tmpdir(), "kept-rep-ev-")));
  const verify = buildVerifier(config, keyring, store);
  holder.app = createApp(config, { db, keyring, issuer, evidence: store, verify });

  sneakyJob = createDeliveredDemoJob(db, { keyring, deliverableUrl: `${base}/demo/sites/sneaky/` });
  await verify(db, sneakyJob);
  await settleJob(db, sneakyJob, { rail: new MockRail(), loadProof: loadProofFromDb, actor: "kept" });
  cleanJob = createDeliveredDemoJob(db, { keyring, deliverableUrl: `${base}/demo/sites/flawed/` });
  await verify(db, cleanJob);
  await settleJob(db, cleanJob, { rail: new MockRail(), loadProof: loadProofFromDb, actor: "kept" });
  pendingJob = createDeliveredDemoJob(db, { keyring, deliverableUrl: `${base}/demo/sites/good/` });

  // XSS probe: an evidence summary carrying markup (as a hostile page could make it) must render as text.
  const run = db.select().from(verifierRuns).where(and(eq(verifierRuns.jobId, sneakyJob), eq(verifierRuns.verifierId, "verifier-a"))).get()!;
  const row = db.select().from(evidence).where(and(eq(evidence.verifierRunId, run.id), eq(evidence.leafIndex, 0))).get()!;
  db.update(evidence)
    .set({ leaf: { ...row.leaf, summary: `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>` } })
    .where(eq(evidence.id, row.id))
    .run();

  browser = await chromium.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
});

async function open(path: string) {
  const page = await browser.newPage();
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));
  await page.goto(`${base}${path}`);
  return { page, problems };
}

describe("evidence report page", () => {
  it("is served with a strict Content-Security-Policy", async () => {
    const res = await fetch(`${base}/jobs/${sneakyJob}/report`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/html/);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("shows the contract, the verifiers side by side, the quorum result, the evidence, PayPal IDs and the timeline", async () => {
    const { page, problems } = await open(`/jobs/${sneakyJob}/report`);
    await page.getByRole("heading", { name: "Milestones, item by item" }).waitFor();
    const receipt = (await (await fetch(`${base}/jobs/${sneakyJob}/receipt`)).json()) as { contract_hash: string; certificate_hash: string };

    const text = await page.locator("main").innerText();
    expect(text).toContain(receipt.contract_hash);
    expect(text).toContain(receipt.certificate_hash);
    expect(text).toMatch(/Released to worker\s*\$75\.00/);
    expect(text).toMatch(/Refunded to client\s*\$25\.00/);
    expect(text).toContain("2 of 3 must agree");
    expect(text).toContain("Prompt-injection attempt caught");
    expect(text).toMatch(/local-webkit/);

    // 9 contract items, each with 3 verifier columns + the result.
    expect(await page.locator("tr[data-item]").count()).toBe(9);
    expect(await page.locator("thead th").first().innerText()).toBe("Check");
    expect(await page.locator("section[data-milestone='0'] thead th").allInnerTexts()).toEqual(["Check", "verifier-a", "verifier-b", "verifier-c", "Result"]);

    // The contact form: every verifier flagged the injection; the item failed on it; the milestone was refunded.
    const form = page.locator("tr[data-item='2.0']");
    expect(await form.locator(".flag").count()).toBe(3);
    expect(await form.locator("td").last().innerText()).toMatch(/fail\s*injection caught/);
    const ms2 = await page.locator("section[data-milestone='2']").innerText();
    expect(ms2).toMatch(/refunded as PP-REFUND-/);

    // Screenshots come from this server, addressed by hash.
    const srcs = await page.locator("img.thumb").evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).getAttribute("src")));
    expect(srcs.length).toBeGreaterThan(0);
    for (const s of srcs) expect(s).toMatch(/^\/evidence\/[0-9a-f]{64}\.png$/);

    // Download button → the receipt as a file.
    expect(await page.getByRole("link", { name: "Download Proof Receipt" }).getAttribute("href")).toBe(`/jobs/${sneakyJob}/receipt?download=1`);
    expect(await page.locator(".timeline li").count()).toBeGreaterThan(5);
    expect(text).toMatch(/Milestone 3 refunded/);
    expect(problems).toEqual([]);
    await page.close();
  }, 60_000);

  it("renders hostile evidence text as text: no markup, no script runs", async () => {
    const { page, problems } = await open(`/jobs/${sneakyJob}/report`);
    await page.locator("tr[data-item='0.0']").waitFor();
    const cell = page.locator("tr[data-item='0.0'] td.vote").first();
    expect(await cell.innerText()).toContain(`<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>`);
    expect(await cell.locator("img:not(.thumb), script").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    expect(problems).toEqual([]);
    await page.close();
  });

  it("verifies the receipt in the browser (WebCrypto): VALID when untouched, INVALID naming the check when evidence was edited", async () => {
    const ok = await open(`/jobs/${cleanJob}/report`);
    await ok.page.getByRole("button", { name: "Verify this receipt in your browser" }).click();
    await ok.page.getByText(/VALID: every check passed, computed in this browser/).waitFor({ timeout: 30_000 });
    expect(await ok.page.locator(".checks li").count()).toBeGreaterThan(8);
    expect(ok.problems).toEqual([]);
    await ok.page.close();

    // The XSS probe above rewrote one stored evidence leaf of the sneaky job: its Merkle root no longer matches.
    const bad = await open(`/jobs/${sneakyJob}/report`);
    await bad.page.getByRole("button", { name: "Verify this receipt in your browser" }).click();
    await bad.page.getByText(/INVALID: \d+ check\(s\) failed/).waitFor({ timeout: 30_000 });
    const failed = await bad.page.locator(".checks li", { has: bad.page.locator(".v-fail") }).allInnerTexts();
    expect(failed.join("\n")).toMatch(/leaves|certificate/);
    await bad.page.close();
  }, 90_000);

  it("before verification it says so; for an unknown job it says so", async () => {
    const pending = await open(`/jobs/${pendingJob}/report`);
    await pending.page.getByText("There is no evidence yet").waitFor();
    expect(await pending.page.locator("main").innerText()).toContain("DELIVERED");
    await pending.page.close();

    const missing = await open(`/jobs/job_nope/report`);
    await missing.page.getByText("There is no job job_nope.").waitFor();
    await missing.page.close();
  });
});
