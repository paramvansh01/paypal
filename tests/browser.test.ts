import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localChromium, localWebkit, panelBrowsers, type BrowserProvider } from "../src/verifier/browser.js";
import { checkUrl, isBlockedIp, isPubliclyReachable } from "../src/verifier/url-guard.js";

describe("url guard", () => {
  const policy = { allowOrigins: ["http://localhost:3000"], resolve: async (h: string) => (h === "evil.example" ? ["10.1.2.3"] : ["93.184.215.14"]) };

  it.each([
    "http://127.0.0.1/",
    "http://127.9.9.9:8080/",
    "http://10.0.0.1/",
    "http://172.16.5.4/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:a9fe:a9fe]/", // 169.254.169.254, hex-mapped
    "http://2130706433/", // 127.0.0.1 as one decimal number
    "http://0x7f.1/", // 127.0.0.1 in hex shorthand
    "http://localhost:3001/",
    "http://admin.localhost/",
    "http://printer.local/",
    "http://metadata.google.internal/",
    "http://evil.example/", // public name, private address
  ])("blocks %s", async (url) => {
    expect((await checkUrl(url, policy)).ok).toBe(false);
  });

  it.each(["file:///etc/passwd", "ftp://example.com/", "javascript:alert(1)", "http://user:pw@example.com/", "not a url"])(
    "blocks non-web or credentialed URL %s",
    async (url) => {
      expect((await checkUrl(url, policy)).ok).toBe(false);
    },
  );

  it("allows public hosts and explicitly allowed origins", async () => {
    expect(await checkUrl("https://example.com/page", policy)).toEqual({ ok: true });
    expect(await checkUrl("http://93.184.215.14/", policy)).toEqual({ ok: true });
    expect(await checkUrl("http://localhost:3000/demo/sites/good/", policy)).toEqual({ ok: true });
  });

  it("explains why", async () => {
    expect(await checkUrl("http://evil.example/", policy)).toEqual({ ok: false, reason: "evil.example resolves to private address 10.1.2.3" });
  });

  it("classifies IPs", () => {
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedIp("2606:4700::1111")).toBe(false);
    expect(isBlockedIp("::ffff:8.8.8.8")).toBe(false);
    expect(isBlockedIp("64:ff9b::10.0.0.1")).toBe(true);
    expect(isBlockedIp("nonsense")).toBe(true);
  });

  it("knows what a cloud browser can reach", () => {
    expect(isPubliclyReachable("https://kept.onrender.com/demo/sites/good/")).toBe(true);
    expect(isPubliclyReachable("http://localhost:3000/demo/")).toBe(false);
    expect(isPubliclyReachable("http://127.0.0.1:3000/")).toBe(false);
  });
});

describe("panel browsers", () => {
  const ids = ["verifier-a", "verifier-b", "verifier-c"];
  it("uses KERNEL for verifier-a only when it can reach the deliverable", () => {
    const pub = panelBrowsers(ids, { kernelApiKey: "k", preferKernel: true, deliverableUrl: "https://site.example/" });
    expect(pub.map((s) => s.provider.kind)).toEqual(["kernel-chromium", "local-chromium", "local-webkit"]);
    const local = panelBrowsers(ids, { kernelApiKey: "k", preferKernel: true, deliverableUrl: "http://localhost:3000/x" });
    expect(local[0]).toMatchObject({ fallback: "deliverable is not reachable from a cloud browser" });
    expect(local[0]!.provider.kind).toBe("local-chromium");
    const noKey = panelBrowsers(ids, { preferKernel: true, deliverableUrl: "https://site.example/" });
    expect(noKey[0]).toMatchObject({ fallback: "no KERNEL_API_KEY" });
  });
});

// ---------- real browsers against a hostile local page ----------

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" }).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Kept test page</title>
      <h1>Hello</h1>
      <img src="http://169.254.169.254/latest/meta-data/iam">
      <script>
        fetch("http://10.0.0.1/admin").catch(() => {});
        try { new WebSocket("ws://192.168.1.1/socket"); } catch (e) {}
      </script>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe.each<[string, () => BrowserProvider]>([
  ["local Chromium", localChromium],
  ["local WebKit", localWebkit],
])("%s", (_name, makeProvider) => {
  it(
    "loads the allowed page and blocks every private request it makes",
    async () => {
      const session = await makeProvider().open({ network: { allowOrigins: [origin] } });
      try {
        expect(session.label).toMatch(/^local-(chromium|webkit) \d/);
        const page = await session.context.newPage();
        await page.goto(`${origin}/`, { waitUntil: "load" });
        expect(await page.title()).toBe("Kept test page");
        await expect.poll(() => session.blocked.map((b) => new URL(b.url.replace(/^ws/, "http")).hostname).sort(), { timeout: 5000 }).toEqual(
          ["10.0.0.1", "169.254.169.254", "192.168.1.1"],
        );
        expect(session.blocked.find((b) => b.url.includes("169.254"))?.reason).toMatch(/private or reserved/);

        // A redirect from an allowed page into the metadata service is blocked too.
        // The browser may show the attempted URL, but the content is our block page, never the metadata.
        const nav = await page.goto(`${origin}/redirect`).catch(() => null);
        if (nav) {
          expect(nav.status()).toBe(403);
          expect(await page.content()).toContain("Blocked by Kept verifier");
        }
        expect(session.blocked.filter((b) => b.url.includes("169.254")).length).toBeGreaterThanOrEqual(2);
      } finally {
        await session.close();
      }
    },
    30_000,
  );

  it(
    "blocks a deliverable on localhost that was not explicitly allowed",
    async () => {
      const session = await makeProvider().open({ network: { allowOrigins: [] } });
      try {
        const page = await session.context.newPage();
        await expect(page.goto(`${origin}/`)).rejects.toThrow();
        expect(session.blocked[0]?.reason).toMatch(/127\.0\.0\.1 is a private or reserved address/);
      } finally {
        await session.close();
      }
    },
    30_000,
  );
});

describe("proxy coverage", () => {
  it.each([
    ["chromium", ["--proxy-bypass-list=<-loopback>"]],
    ["webkit", []],
  ] as const)(
    "%s sends loopback traffic through the proxy (so the egress guard sees it)",
    async (name, args) => {
      const { chromium, webkit } = await import("playwright");
      const seen: string[] = [];
      const proxy = createServer((req, res) => {
        seen.push(req.url ?? "");
        res.writeHead(200, { "content-type": "text/html" }).end("<title>via proxy</title>");
      });
      await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
      const browser = await (name === "chromium" ? chromium : webkit).launch({
        proxy: { server: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}` },
        args: [...args],
      });
      try {
        const page = await browser.newPage();
        await page.goto("http://127.0.0.1:4321/probe");
        expect(seen).toContain("http://127.0.0.1:4321/probe");
        expect(await page.title()).toBe("via proxy");
      } finally {
        await browser.close();
        await new Promise<void>((r) => proxy.close(() => r()));
      }
    },
    30_000,
  );
});
