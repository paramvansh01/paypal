import { Ajv } from "ajv";
import type { Page, Response } from "playwright";
import type { ChecklistItem } from "../../core/checklist.js";
import type { Check, CheckContext, CheckResult } from "./types.js";

export type { Check, CheckContext, CheckResult } from "./types.js";

/**
 * Deterministic checks from section 6.7. Each check opens its own page in the
 * verifier's isolated context, reports a verdict with a measured value and a
 * screenshot, and never trusts what the page says about itself:
 *   - text only counts if a person could see it;
 *   - a form only "submits" if its success signal appears after submitting;
 *   - every request goes through the browser (and so through the network guard).
 */

type ItemOf<T extends ChecklistItem["check_type"]> = Extract<ChecklistItem, { check_type: T }>;

export class TargetError extends Error {}

/**
 * Resolves a check's `path` against the deliverable URL. "/" is the
 * deliverable itself; other paths are relative to its directory and may not
 * climb out of it.
 */
export function resolveTarget(deliverableUrl: string, path: string): string {
  const base = new URL(deliverableUrl);
  if (path === "/") return base.href;
  const dir = new URL(base.pathname.endsWith("/") ? base.href : base.href.replace(/[^/]*$/, ""));
  dir.search = "";
  dir.hash = "";
  const target = new URL(path.replace(/^\//, ""), dir);
  if (target.origin !== dir.origin || !target.pathname.startsWith(dir.pathname)) {
    throw new TargetError(`path ${path} points outside the deliverable`);
  }
  return target.href;
}

const normalise = (s: string) => s.replace(/\s+/g, " ").trim();

async function snap(page: Page): Promise<Buffer | undefined> {
  return page.screenshot({ type: "png", animations: "disabled" }).catch(() => undefined);
}

/** Opens a fresh page at the target. Returns the page and the main response (null if blocked or unreachable). */
async function open(
  ctx: CheckContext,
  path: string,
  opts: { viewport?: { width: number; height: number }; waitUntil?: "load" | "domcontentloaded" } = {},
): Promise<{ page: Page; response: Response | null; url: string; error?: string; pageErrors: string[]; consoleErrors: string[] }> {
  const url = resolveTarget(ctx.deliverableUrl, path);
  const page = await ctx.session.context.newPage();
  // Collect script errors from the very first byte, so errors thrown during load are evidence too.
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  if (opts.viewport) await page.setViewportSize(opts.viewport);
  page.setDefaultTimeout(ctx.timeoutMs);
  let response: Response | null = null;
  let error: string | undefined;
  try {
    response = await page.goto(url, { waitUntil: opts.waitUntil ?? "load", timeout: ctx.timeoutMs });
    await ctx.onPageLoaded?.(page, url);
  } catch (err) {
    error = err instanceof Error ? err.message.split("\n")[0] : String(err);
  }
  return { page, response, url, error, pageErrors, consoleErrors };
}

function unreachable(url: string, error: string, screenshot?: Buffer): CheckResult {
  return { verdict: "fail", measured_value: null, summary: `Could not load ${url}: ${error}`, screenshot };
}

/** First visible element matching the text, if any. */
async function visibleText(page: Page, text: string): Promise<boolean> {
  const matches = page.getByText(normalise(text), { exact: false });
  const n = Math.min(await matches.count(), 20);
  for (let i = 0; i < n; i++) if (await matches.nth(i).isVisible()) return true;
  return false;
}

// ---------- the checks ----------

const httpStatus: Check<ItemOf<"http_status">> = async (item, ctx) => {
  const { page, response, url, error } = await open(ctx, item.params.path, { waitUntil: "domcontentloaded" });
  try {
    if (!response) return unreachable(url, error ?? "no response", await snap(page));
    const status = response.status();
    const ok = status === item.params.expected;
    return {
      verdict: ok ? "pass" : "fail",
      measured_value: String(status),
      summary: ok ? `${url} returned ${status}` : `${url} returned ${status}, expected ${item.params.expected}`,
      screenshot: await snap(page),
    };
  } finally {
    await page.close();
  }
};

const textPresent: Check<ItemOf<"text_present">> = async (item, ctx) => {
  const { page, response, url, error } = await open(ctx, item.params.path);
  try {
    if (!response?.ok()) return unreachable(url, error ?? `status ${response?.status()}`, await snap(page));
    const visible = await visibleText(page, item.params.text);
    const inMarkup = !visible && normalise(await page.content()).includes(normalise(item.params.text));
    return {
      verdict: visible ? "pass" : "fail",
      measured_value: visible ? "visible" : inMarkup ? "present but hidden" : "absent",
      summary: visible
        ? `"${item.params.text}" is visible on ${url}`
        : inMarkup
          ? `"${item.params.text}" is in the page source but not visible to a person`
          : `"${item.params.text}" was not found on ${url}`,
      screenshot: await snap(page),
    };
  } finally {
    await page.close();
  }
};

const elementExists: Check<ItemOf<"element_exists">> = async (item, ctx) => {
  const { page, response, url, error } = await open(ctx, item.params.path);
  try {
    if (!response?.ok()) return unreachable(url, error ?? `status ${response?.status()}`, await snap(page));
    let count: number;
    try {
      count = await page.locator(item.params.selector).count();
    } catch (err) {
      return {
        verdict: "error",
        measured_value: null,
        summary: `The contract's selector ${item.params.selector} is not valid CSS: ${(err as Error).message.split("\n")[0]}`,
      };
    }
    return {
      verdict: count > 0 ? "pass" : "fail",
      measured_value: String(count),
      summary: count > 0 ? `${count} element(s) match ${item.params.selector}` : `Nothing matches ${item.params.selector} on ${url}`,
      screenshot: await snap(page),
    };
  } finally {
    await page.close();
  }
};

const formSubmits: Check<ItemOf<"form_submits">> = async (item, ctx) => {
  const { page, response, url, error, pageErrors, consoleErrors } = await open(ctx, item.params.path);
  try {
    if (!response?.ok()) return unreachable(url, error ?? `status ${response?.status()}`, await snap(page));
    const form = page.locator(item.params.form_selector).first();
    if ((await form.count()) === 0) {
      return { verdict: "fail", measured_value: "no form", summary: `No form matches ${item.params.form_selector}`, screenshot: await snap(page) };
    }
    const { success } = item.params;
    const alreadyVisible = success.text ? await visibleText(page, success.text) : false;
    const presentInSource = success.text ? normalise(await page.content()).includes(normalise(success.text)) : false;

    for (const [selector, value] of Object.entries(item.params.fields)) {
      const field = page.locator(selector).first();
      if ((await field.count()) === 0) {
        return { verdict: "fail", measured_value: "missing field", summary: `Field ${selector} is missing`, screenshot: await snap(page) };
      }
      await field.fill(value);
    }

    const waitResponse = success.response_status
      ? page
          .waitForResponse((r) => r.request().method() !== "GET" && r.status() === success.response_status, { timeout: ctx.timeoutMs })
          .then(() => true)
          .catch(() => false)
      : Promise.resolve(true);
    const submit = form.locator('button[type="submit"], input[type="submit"], button:not([type])').first();
    if ((await submit.count()) > 0) await submit.click();
    else await form.evaluate((f) => (f as HTMLFormElement).requestSubmit());

    const deadline = Date.now() + ctx.timeoutMs;
    let textOk = !success.text;
    let urlOk = !success.url_contains;
    while (Date.now() < deadline && !(textOk && urlOk)) {
      if (!textOk) textOk = await visibleText(page, success.text!).catch(() => false);
      if (!urlOk) urlOk = page.url().includes(success.url_contains!);
      if (!(textOk && urlOk)) await page.waitForTimeout(150);
    }
    const responseOk = await waitResponse;
    // A success message that was already showing before we submitted proves nothing.
    const passed = textOk && urlOk && responseOk && !alreadyVisible;
    const signals = [
      success.text && `text "${success.text}" ${textOk ? "appeared" : "did not appear"}`,
      success.url_contains && `URL ${urlOk ? "contains" : "does not contain"} "${success.url_contains}"`,
      success.response_status && `response ${success.response_status} ${responseOk ? "seen" : "not seen"}`,
    ].filter(Boolean);
    const errors = [...pageErrors, ...consoleErrors];
    return {
      verdict: passed ? "pass" : "fail",
      measured_value: passed ? "submitted" : "no confirmation",
      summary:
        (passed ? "Form submitted and confirmed: " : "Form did not confirm: ") +
        signals.join("; ") +
        (alreadyVisible ? ". The success text was already visible before submitting" : "") +
        (!alreadyVisible && presentInSource && !passed ? ". The success text exists in the page source but stayed hidden" : "") +
        (errors.length ? `. Page errors: ${errors.slice(0, 3).join(" | ")}` : ""),
      screenshot: await snap(page),
      details: { page_errors: pageErrors, console_errors: consoleErrors, success_hidden_in_source_before_submit: presentInSource && !alreadyVisible },
    };
  } finally {
    await page.close();
  }
};

const loadTimeUnder: Check<ItemOf<"load_time_under">> = async (item, ctx) => {
  const { page, response, url, error } = await open(ctx, item.params.path, { waitUntil: "load" });
  try {
    if (!response?.ok()) return unreachable(url, error ?? `status ${response?.status()}`, await snap(page));
    const ms = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      return nav ? Math.round(nav.loadEventEnd - nav.startTime) : -1;
    });
    if (ms < 0) return { verdict: "error", measured_value: null, summary: "The browser did not report navigation timing" };
    const ok = ms <= item.params.ms;
    return {
      verdict: ok ? "pass" : "fail",
      measured_value: `${ms} ms`,
      summary: `${url} finished loading in ${ms} ms (limit ${item.params.ms} ms)`,
      screenshot: await snap(page),
    };
  } finally {
    await page.close();
  }
};

const mobileNoOverflow: Check<ItemOf<"mobile_no_overflow">> = async (item, ctx) => {
  const viewport = { width: item.params.viewport_width, height: 844 };
  const { page, response, url, error } = await open(ctx, item.params.path, { viewport });
  try {
    if (!response?.ok()) return unreachable(url, error ?? `status ${response?.status()}`, await snap(page));
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
      innerWidth: window.innerWidth,
    }));
    const ok = scrollWidth <= innerWidth + 1;
    return {
      verdict: ok ? "pass" : "fail",
      measured_value: `${scrollWidth}px content / ${innerWidth}px screen`,
      summary: ok
        ? `No sideways scrolling at ${viewport.width}px wide`
        : `Content is ${scrollWidth}px wide on a ${innerWidth}px screen, so people must scroll sideways`,
      screenshot: await snap(page),
    };
  } finally {
    await page.close();
  }
};

const linksOk: Check<ItemOf<"links_ok">> = async (item, ctx) => {
  const { page, response, url, error } = await open(ctx, item.params.path);
  try {
    if (!response?.ok()) return unreachable(url, error ?? `status ${response?.status()}`, await snap(page));
    const hrefs: string[] = await page.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href));
    const links = [...new Set(hrefs.map((h) => h.split("#")[0]!).filter((h) => /^https?:/i.test(h)))].slice(0, item.params.max_links);
    const screenshot = await snap(page);
    const results: { url: string; status: number | null; error?: string }[] = [];
    // Check through real navigations (so the network guard applies), four at a time.
    const queue = [...links];
    await Promise.all(
      Array.from({ length: Math.min(4, queue.length) }, async () => {
        const p = await ctx.session.context.newPage();
        try {
          for (let link = queue.shift(); link; link = queue.shift()) {
            try {
              const r = await p.goto(link, { waitUntil: "domcontentloaded", timeout: ctx.timeoutMs });
              results.push({ url: link, status: r?.status() ?? null });
            } catch (err) {
              results.push({ url: link, status: null, error: (err as Error).message.split("\n")[0] });
            }
          }
        } finally {
          await p.close();
        }
      }),
    );
    const broken = results.filter((r) => r.status === null || r.status >= 400);
    return {
      verdict: broken.length === 0 ? "pass" : "fail",
      measured_value: `${results.length - broken.length}/${results.length} links ok`,
      summary:
        links.length === 0
          ? `No links found on ${url}`
          : broken.length === 0
            ? `All ${links.length} links on ${url} work`
            : `Broken: ${broken
                .slice(0, 5)
                .map((b) => `${b.url} (${b.status ?? b.error})`)
                .join(", ")}`,
      screenshot,
      details: { links: results.sort((a, b) => a.url.localeCompare(b.url)) },
    };
  } finally {
    await page.close();
  }
};

const ajv = new Ajv({ allErrors: true, strict: false });

const jsonSchemaValid: Check<ItemOf<"json_schema_valid">> = async (item, ctx) => {
  const { page, response, url, error } = await open(ctx, item.params.path, { waitUntil: "domcontentloaded" });
  try {
    if (!response?.ok()) return unreachable(url, error ?? `status ${response?.status()}`);
    let data: unknown;
    try {
      data = JSON.parse(await response.text());
    } catch {
      return { verdict: "fail", measured_value: "not JSON", summary: `${url} did not return valid JSON` };
    }
    let validate;
    try {
      validate = ajv.compile(item.params.schema);
    } catch (err) {
      return { verdict: "error", measured_value: null, summary: `The contract's JSON Schema is invalid: ${(err as Error).message}` };
    }
    const ok = validate(data) as boolean;
    const errors = (validate.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || "(root)"} ${e.message}`);
    return {
      verdict: ok ? "pass" : "fail",
      measured_value: ok ? "valid" : `${validate.errors?.length ?? 0} error(s)`,
      summary: ok ? `${url} matches the schema` : `${url} does not match the schema: ${errors.join("; ")}`,
      details: { errors: validate.errors ?? [] },
    };
  } finally {
    await page.close();
  }
};

const clientApproval: Check<ItemOf<"client_approval">> = async () => ({
  verdict: "needs_client",
  measured_value: null,
  summary: "Waiting for the client to approve or reject",
});

/** Placeholder until T3.6: without the AI judge, a person decides. */
const llmJudgementUnavailable: Check<ItemOf<"llm_judgement">> = async () => ({
  verdict: "needs_client",
  measured_value: null,
  summary: "AI judge not configured on this verifier; the client decides",
});

export const CHECKS: { [K in ChecklistItem["check_type"]]: Check<ItemOf<K>> } = {
  http_status: httpStatus,
  text_present: textPresent,
  element_exists: elementExists,
  form_submits: formSubmits,
  load_time_under: loadTimeUnder,
  mobile_no_overflow: mobileNoOverflow,
  links_ok: linksOk,
  json_schema_valid: jsonSchemaValid,
  llm_judgement: llmJudgementUnavailable,
  client_approval: clientApproval,
};

/** Runs the right check for an item. Unexpected exceptions become `error` (the verifier failed, not the worker). */
export async function runCheck(item: ChecklistItem, ctx: CheckContext): Promise<CheckResult> {
  try {
    const check = CHECKS[item.check_type] as Check;
    return await check(item, ctx);
  } catch (err) {
    if (err instanceof TargetError) return { verdict: "error", measured_value: null, summary: err.message };
    return { verdict: "error", measured_value: null, summary: `Verifier error: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
  }
}
