import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChecklistItem } from "../src/core/checklist.js";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server/app.js";
import { localChromium, localWebkit, type BrowserProvider, type BrowserSession } from "../src/verifier/browser.js";
import { resolveTarget, runCheck, type CheckContext } from "../src/verifier/checks/index.js";

const demoContract = JSON.parse(readFileSync(new URL("../demo/contract.json", import.meta.url), "utf8")) as {
  milestones: { title: string; items: unknown[] }[];
};
const demoItems = demoContract.milestones.flatMap((m, mi) => m.items.map((raw, ii) => ({ key: `${mi}.${ii}`, item: ChecklistItem.parse(raw) })));
const item = (raw: unknown) => ChecklistItem.parse(raw);

let app: Server;
let appOrigin: string;
let fixtures: Server;
let fxOrigin: string;

beforeAll(async () => {
  app = createApp(loadConfig({})).listen(0, "127.0.0.1");
  await new Promise((r) => app.once("listening", r));
  appOrigin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

  const pages: Record<string, { status?: number; type?: string; body: string; delayMs?: number }> = {
    "/site/": { body: `<title>fx</title><p>Visible words</p><p style="display:none">Secret words</p><div class="x">x</div>` },
    "/site/wide.html": { body: `<meta name="viewport" content="width=device-width"><div style="width:1200px">too wide</div>` },
    "/site/narrow.html": { body: `<meta name="viewport" content="width=device-width"><p>fits</p>` },
    "/site/slow.html": { body: `<p>slow</p>`, delayMs: 1200 },
    "/site/links.html": { body: `<a href="narrow.html">ok</a><a href="missing.html">missing</a><a href="http://10.0.0.1/admin">internal</a><a href="mailto:a@b.co">mail</a>` },
    "/site/data.json": { type: "application/json", body: JSON.stringify({ id: 7, name: "Widget", tags: ["a"] }) },
    "/site/notjson.json": { type: "application/json", body: "{oops" },
  };
  fixtures = createServer((req, res) => {
    const p = pages[(req.url ?? "").split("?")[0]!];
    if (!p) {
      res.writeHead(404, { "content-type": "text/html" }).end("<title>404</title>not found");
      return;
    }
    setTimeout(() => res.writeHead(p.status ?? 200, { "content-type": p.type ?? "text/html" }).end(p.body), p.delayMs ?? 0);
  });
  await new Promise<void>((r) => fixtures.listen(0, "127.0.0.1", r));
  fxOrigin = `http://127.0.0.1:${(fixtures.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => app.close(r));
  await new Promise((r) => fixtures.close(r));
});

describe("resolveTarget", () => {
  it("resolves paths inside the deliverable", () => {
    expect(resolveTarget("https://x.example/site/", "/")).toBe("https://x.example/site/");
    expect(resolveTarget("https://x.example/site/", "/contact.html")).toBe("https://x.example/site/contact.html");
    expect(resolveTarget("https://x.example/site/index.html", "/menu.html")).toBe("https://x.example/site/menu.html");
    expect(resolveTarget("https://x.example/site/?v=1", "/a/b.html")).toBe("https://x.example/site/a/b.html");
  });
  it("refuses paths that climb out of the deliverable", () => {
    expect(() => resolveTarget("https://x.example/site/", "/../admin")).toThrow(/outside the deliverable/);
    expect(() => resolveTarget("https://x.example/site/", "/..%2f..%2fadmin")).not.toThrow(); // encoded: stays a file name inside
  });
});

const engines: [string, () => BrowserProvider][] = [
  ["Chromium", localChromium],
  ["WebKit", localWebkit],
];

describe.each(engines)("demo sites in %s", (_engine, provider) => {
  let session: BrowserSession;
  beforeAll(async () => {
    session = await provider().open({ network: { allowOrigins: [appOrigin] } });
  }, 30_000);
  afterAll(() => session.close());

  const ctx = (site: string): CheckContext => ({ session, deliverableUrl: `${appOrigin}/demo/sites/${site}/`, timeoutMs: 5000 });

  it("good: every item passes", async () => {
    const results = [];
    for (const { key, item } of demoItems) results.push({ key, ...(await runCheck(item, ctx("good"))) });
    expect(results.filter((r) => r.verdict !== "pass").map((r) => `${r.key}: ${r.summary}`)).toEqual([]);
    expect(results.every((r) => r.screenshot && r.screenshot.length > 1000)).toBe(true);
  }, 60_000);

  it("flawed: only the contact form fails, with the page's own error as evidence", async () => {
    const results = [];
    for (const { key, item } of demoItems) results.push({ key, ...(await runCheck(item, ctx("flawed"))) });
    expect(results.filter((r) => r.verdict !== "pass").map((r) => r.key)).toEqual(["2.0"]);
    const form = results.find((r) => r.key === "2.0")!;
    expect(form.verdict).toBe("fail");
    expect(form.summary).toMatch(/did not appear/);
    expect(form.summary).toMatch(/Page errors: .*null/i);
    // The broken script throws on load, and again after the native submit reloads the page.
    expect((form.details!.page_errors as string[]).length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("sneaky: the pre-planted hidden success text does not fool the form check", async () => {
    const formItem = demoItems.find((d) => d.key === "2.0")!.item;
    const r = await runCheck(formItem, ctx("sneaky"));
    expect(r.verdict).toBe("fail");
    expect(r.summary).toMatch(/exists in the page source but stayed hidden/);
    expect(r.details!.success_hidden_in_source_before_submit).toBe(true);
  }, 30_000);
});

describe("check edge cases (Chromium)", () => {
  let session: BrowserSession;
  beforeAll(async () => {
    session = await localChromium().open({ network: { allowOrigins: [fxOrigin] } });
  }, 30_000);
  afterAll(() => session.close());
  const ctx = (): CheckContext => ({ session, deliverableUrl: `${fxOrigin}/site/`, timeoutMs: 4000 });
  const run = (raw: unknown) => runCheck(item(raw), ctx());

  it("http_status reports the real status", async () => {
    expect(await run({ description: "d", check_type: "http_status", params: { path: "/nope.html" } })).toMatchObject({
      verdict: "fail",
      measured_value: "404",
    });
    expect(await run({ description: "d", check_type: "http_status", params: { path: "/nope.html", expected: 404 } })).toMatchObject({
      verdict: "pass",
    });
  });

  it("text_present ignores text a person cannot see", async () => {
    expect(await run({ description: "d", check_type: "text_present", params: { text: "Visible   words" } })).toMatchObject({ verdict: "pass" });
    expect(await run({ description: "d", check_type: "text_present", params: { text: "Secret words" } })).toMatchObject({
      verdict: "fail",
      measured_value: "present but hidden",
    });
  });

  it("element_exists counts matches and flags a bad selector as a verifier error", async () => {
    expect(await run({ description: "d", check_type: "element_exists", params: { selector: ".x" } })).toMatchObject({
      verdict: "pass",
      measured_value: "1",
    });
    expect(await run({ description: "d", check_type: "element_exists", params: { selector: ".nothing" } })).toMatchObject({ verdict: "fail" });
    expect(await run({ description: "d", check_type: "element_exists", params: { selector: "div[" } })).toMatchObject({ verdict: "error" });
  });

  it("mobile_no_overflow measures horizontal overflow", async () => {
    const wide = await run({ description: "d", check_type: "mobile_no_overflow", params: { path: "/wide.html" } });
    expect(wide.verdict).toBe("fail");
    expect(wide.measured_value).toMatch(/^1\d{3}px content \/ 390px screen$/);
    expect(await run({ description: "d", check_type: "mobile_no_overflow", params: { path: "/narrow.html" } })).toMatchObject({ verdict: "pass" });
  });

  it("load_time_under measures the real load", async () => {
    const slow = await run({ description: "d", check_type: "load_time_under", params: { path: "/slow.html", ms: 500 } });
    expect(slow.verdict).toBe("fail");
    expect(parseInt(slow.measured_value!)).toBeGreaterThanOrEqual(1000);
    expect(await run({ description: "d", check_type: "load_time_under", params: { path: "/narrow.html", ms: 3000 } })).toMatchObject({
      verdict: "pass",
    });
  });

  it("links_ok finds broken and blocked links, skips mailto", async () => {
    const r = await run({ description: "d", check_type: "links_ok", params: { path: "/links.html" } });
    expect(r.verdict).toBe("fail");
    expect(r.measured_value).toBe("1/3 links ok");
    expect(r.summary).toMatch(/missing\.html \(404\)/);
    expect(r.summary).toMatch(/10\.0\.0\.1/);
  });

  it("json_schema_valid validates the response", async () => {
    const schema = { type: "object", required: ["id", "name"], properties: { id: { type: "integer" }, name: { type: "string" } } };
    expect(await run({ description: "d", check_type: "json_schema_valid", params: { path: "/data.json", schema } })).toMatchObject({
      verdict: "pass",
    });
    const strict = { ...schema, required: ["id", "price"] };
    const bad = await run({ description: "d", check_type: "json_schema_valid", params: { path: "/data.json", schema: strict } });
    expect(bad).toMatchObject({ verdict: "fail" });
    expect(bad.summary).toMatch(/price/);
    expect(await run({ description: "d", check_type: "json_schema_valid", params: { path: "/notjson.json", schema } })).toMatchObject({
      verdict: "fail",
      measured_value: "not JSON",
    });
    expect(
      await run({ description: "d", check_type: "json_schema_valid", params: { path: "/data.json", schema: { type: "nonsense" } } }),
    ).toMatchObject({ verdict: "error" });
  });

  it("client_approval always waits for the client", async () => {
    expect(await run({ description: "d", check_type: "client_approval", params: {} })).toMatchObject({ verdict: "needs_client" });
  });

  it("an unreachable deliverable is the worker's failure", async () => {
    const blockedSession = await localChromium().open({ network: { allowOrigins: [] } });
    try {
      const r = await runCheck(item({ description: "d", check_type: "http_status", params: {} }), {
        session: blockedSession,
        deliverableUrl: `${fxOrigin}/site/`,
        timeoutMs: 4000,
      });
      expect(r.verdict).toBe("fail");
      expect(r.summary).toMatch(/Could not load/);
    } finally {
      await blockedSession.close();
    }
  });
});
