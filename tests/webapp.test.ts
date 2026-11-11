import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/client.js";
import { DEMO_CLIENT_ID, DEMO_WORKER_ID, seedDemoParties } from "../src/db/seed.js";
import { loadKeyring } from "../src/qaps/keys.js";
import { verifierIds } from "../src/qaps/protocol.js";
import { ISSUER_ID } from "../src/qaps/receipt.js";
import { offlineRail } from "../src/rails/offline.js";
import { createApp } from "../src/server/app.js";
import { partyToken } from "../src/server/auth.js";
import { buildVerifier } from "../src/server/verifier.js";
import { EvidenceStore } from "../src/verifier/evidence-store.js";

const SECRET = "webapp-test-secret-0123456789";
let server: Server;
let base: string;
let browser: Browser;

beforeAll(async () => {
  const holder: { app?: ReturnType<typeof createApp> } = {};
  server = createServer((req, res) => holder.app!(req, res)).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = loadConfig({ MCP_AUTH_TOKEN: SECRET, DEMO_MODE: "1", PUBLIC_BASE_URL: base, PORT: new URL(base).port, DEMO_CLIENT_EMAIL: "c@example.com", DEMO_WORKER_EMAIL: "w@example.com" });
  const db = openDb(":memory:");
  seedDemoParties(db, config);
  const keyring = loadKeyring(verifierIds(3), { dir: mkdtempSync(join(tmpdir(), "kept-web-keys-")) });
  const issuer = loadKeyring([ISSUER_ID], { dir: mkdtempSync(join(tmpdir(), "kept-web-iss-")) }).get(ISSUER_ID)!;
  const evidence = new EvidenceStore(mkdtempSync(join(tmpdir(), "kept-web-ev-")));
  holder.app = createApp(config, { db, keyring, issuer, evidence, rail: offlineRail(), verify: buildVerifier(config, keyring, evidence) });
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
});

async function page(): Promise<{ page: Page; problems: string[] }> {
  const p = await (await browser.newContext()).newPage();
  const problems: string[] = [];
  p.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  p.on("pageerror", (e) => problems.push(e.message));
  return { page: p, problems };
}

describe("web app", () => {
  it("a client and a worker run a whole job by clicking: post, accept, lock, confirm, deliver, verify (live votes), settle", async () => {
    const client = await page();
    const worker = await page();
    const c = client.page;
    const w = worker.page;

    await c.goto(base);
    await c.getByText("OFFLINE stand-in for PayPal").waitFor();
    await c.getByRole("button", { name: "Sign in to post a job" }).click();
    await c.getByRole("button", { name: "Act as the demo client" }).click();
    await c.getByText("Acting as").waitFor();
    await c.getByRole("link", { name: "Post a job" }).click();
    await c.getByRole("button", { name: "Post job and propose this contract" }).click();
    await c.waitForURL(/\/app\/jobs\/job_/);
    const jobUrl = c.url();
    await c.getByRole("button", { name: "Accept this contract" }).click();
    await c.getByText(/You accepted contract/).waitFor();

    await w.goto(jobUrl);
    await w.getByRole("button", { name: "Sign in" }).first().click();
    await w.getByRole("button", { name: "Act as the demo worker" }).click();
    await w.getByRole("button", { name: "Accept this contract" }).click();
    await w.locator("text=Frozen. Fingerprint").waitFor();

    await c.reload();
    await c.getByRole("button", { name: "Lock funds with PayPal" }).click();
    await c.getByRole("button", { name: /I approved it/ }).click();
    await c.locator(".stepper li.now", { hasText: "Funded" }).waitFor();
    expect(await c.locator("[data-panel=money]").innerText()).toMatch(/Held by PayPal\s*\$100\.00/);

    await w.reload();
    await w.getByRole("button", { name: "use demo: flawed" }).click();
    await w.getByRole("button", { name: "Submit delivery" }).click();
    await w.getByRole("button", { name: "Run the verifiers" }).click();
    // Each verifier's vote shows up under its item; then the final verdict.
    await w.getByRole("button", { name: "Settle on PayPal" }).waitFor({ timeout: 60_000 });
    expect(await w.locator("[data-item='2.0'] .votes .badge").count()).toBe(3);
    expect(await w.locator("[data-item='2.0']").innerText()).toMatch(/fail\s*quorum agreed/);
    await w.getByRole("button", { name: "Settle on PayPal" }).click();
    await w.locator(".stepper li.now", { hasText: "Settled" }).waitFor();
    const moneyText = await w.locator("[data-panel=money]").innerText();
    expect(moneyText).toMatch(/Released to worker\s*\$75\.00/);
    expect(moneyText).toMatch(/Refunded to client\s*\$25\.00/);
    expect(moneyText).toContain("OFFLINE-REFUND-");
    expect(await w.getByRole("link", { name: "Download Proof Receipt" }).getAttribute("href")).toMatch(/\/receipt\?download=1$/);
    expect(await w.locator(".timeline li").count()).toBeGreaterThan(8);

    expect(client.problems).toEqual([]);
    expect(worker.problems).toEqual([]);
  }, 120_000);

  it("a stranger can watch but not act; hostile titles render as text", async () => {
    const res = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${partyToken(SECRET, DEMO_CLIENT_ID)}` },
      body: JSON.stringify({ title: `<img src=x onerror="window.__xss=1">`, brief: "<script>window.__xss=2</script>", worker_id: DEMO_WORKER_ID, budget_cents: 100 }),
    });
    const job = (await res.json()) as { id: string };
    const { page: p, problems } = await page();
    await p.goto(base);
    await p.locator(`tr[data-job='${job.id}']`).waitFor();
    expect(await p.locator(`tr[data-job='${job.id}'] a`).innerText()).toBe(`<img src=x onerror="window.__xss=1">`);
    await p.goto(`${base}/app/jobs/${job.id}`);
    await p.getByText("Sign in as the client or the worker").waitFor();
    expect(await p.locator("main img").count()).toBe(0);
    expect(await p.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    const csp = (await fetch(`${base}/app/jobs/${job.id}`)).headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(problems).toEqual([]);
  }, 60_000);
});
