/**
 * npm run doctor — checks this machine's setup service by service.
 * Exits non-zero if any check fails. Safe to run any time: it spends one tiny
 * LLM call and opens (then deletes) one browser session.
 */
import Anthropic from "@anthropic-ai/sdk";
import Kernel from "@onkernel/sdk";
import { chromium, type Browser } from "playwright";
import { ConfigError, loadConfig, missingKeys, type Config, type ConfigGroup } from "../src/config.js";
import { openDb } from "../src/db/client.js";
import { requestAccessToken } from "../src/paypal/token.js";

type Status = "PASS" | "FAIL" | "SKIP";
interface Result {
  name: string;
  status: Status;
  detail: string;
}

const TIMEOUT_MS = 45_000;

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await Promise.race([
      fn(ctrl.signal),
      new Promise<never>((_, reject) =>
        ctrl.signal.addEventListener("abort", () => reject(new Error(`timed out after ${ms / 1000}s`))),
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function run(name: string, fn: () => Promise<string>): Promise<Result> {
  try {
    return { name, status: "PASS", detail: await fn() };
  } catch (err) {
    return { name, status: "FAIL", detail: err instanceof Error ? err.message.split("\n")[0]! : String(err) };
  }
}

function envCheck(config: Config, group: ConfigGroup, label: string): Result {
  const missing = missingKeys(config, group);
  return missing.length
    ? { name: `env: ${label}`, status: "FAIL", detail: `missing ${missing.join(", ")}` }
    : { name: `env: ${label}`, status: "PASS", detail: "all keys set" };
}

const PROBE_PAGE = "data:text/html,<title>kept-doctor</title><h1>ok</h1>";

async function checkBrowser(config: Config): Promise<string> {
  if (config.verifier.browser === "local") {
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch();
      const page = await browser.newPage();
      await page.goto(PROBE_PAGE);
      return `local Chromium ${browser.version()} opened a page (title "${await page.title()}")`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/Executable doesn't exist|npx playwright install/.test(msg)) {
        throw new Error("Chromium not installed. Run: npx playwright install chromium", { cause: err });
      }
      throw err;
    } finally {
      await browser?.close();
    }
  }
  const kernel = new Kernel({ apiKey: config.verifier.kernelApiKey });
  const session = await kernel.browsers.create({ headless: true });
  let browser: Browser | undefined;
  try {
    browser = await chromium.connectOverCDP(session.cdp_ws_url);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(PROBE_PAGE);
    return `KERNEL session ${session.session_id} opened a page (title "${await page.title()}")`;
  } finally {
    await browser?.close().catch(() => {});
    await kernel.browsers.deleteByID(session.session_id).catch(() => {});
  }
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const results: Result[] = [
    envCheck(config, "paypal", `PayPal (${config.paypal.rail} rail)`),
    envCheck(config, "demo", "demo parties"),
    envCheck(config, "llm", "LLM"),
    envCheck(config, "verifier", `verifier (${config.verifier.browser})`),
    envCheck(config, "mcp", "MCP auth"),
  ];
  // The webhook ID only matters on the hosted deployment, so it is advisory.
  if (missingKeys(config, "webhooks").length) {
    results.push({ name: "env: webhooks", status: "SKIP", detail: "PAYPAL_WEBHOOK_ID unset (only needed when hosted)" });
  }

  results.push(
    await run("database", async () => {
      const db = openDb(config.app.databasePath);
      const n = db.$client.prepare("select count(*) as n from parties").get() as { n: number };
      db.$client.close();
      return `${config.app.databasePath} migrated, ${n.n} parties`;
    }),
  );

  const { clientId, clientSecret, baseUrl } = config.paypal;
  results.push(
    clientId && clientSecret
      ? await run("PayPal token", () =>
          withTimeout(TIMEOUT_MS, async (signal) => {
            const t = await requestAccessToken(baseUrl, clientId, clientSecret, signal);
            return `got ${t.token_type} token from ${new URL(baseUrl).host}, expires in ${t.expires_in}s`;
          }),
        )
      : { name: "PayPal token", status: "FAIL", detail: "needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET" },
  );

  const { apiKey, model } = config.llm;
  results.push(
    apiKey && model
      ? await run("LLM call", () =>
          withTimeout(TIMEOUT_MS, async () => {
            const client = new Anthropic({ apiKey, maxRetries: 1 });
            const res = await client.messages.create({
              model,
              max_tokens: 1024,
              output_config: { effort: "low" },
              messages: [{ role: "user", content: "Reply with the single word: ok" }],
            });
            const text = res.content.flatMap((b) => (b.type === "text" ? [b.text.trim()] : [])).join(" ");
            return `${res.model} replied "${text.slice(0, 20)}" (stop: ${res.stop_reason})`;
          }),
        )
      : { name: "LLM call", status: "FAIL", detail: "needs ANTHROPIC_API_KEY and LLM_MODEL" },
  );

  const browserReady = config.verifier.browser === "local" || Boolean(config.verifier.kernelApiKey);
  results.push(
    browserReady
      ? await run(`verifier browser (${config.verifier.browser})`, () => withTimeout(TIMEOUT_MS * 2, () => checkBrowser(config)))
      : {
          name: "verifier browser (kernel)",
          status: "FAIL",
          detail: "needs KERNEL_API_KEY, or set VERIFIER_BROWSER=local",
        },
  );

  const width = Math.max(...results.map((r) => r.name.length));
  console.log("\nKept doctor\n");
  for (const r of results) console.log(`  ${r.status}  ${r.name.padEnd(width)}  ${r.detail}`);
  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log(failed ? `\n${failed} check(s) failed. See CLAUDE.md section 5 for setup steps.\n` : "\nAll checks passed.\n");
  process.exit(failed ? 1 : 0);
}

void main();
