import Kernel from "@onkernel/sdk";
import { chromium, webkit, type Browser, type BrowserContext } from "playwright";
import { startEgressProxy } from "./egress-proxy.js";
import { checkUrl, isPubliclyReachable, type NetworkPolicy } from "./url-guard.js";

/**
 * Browser providers for the verifier panel (section 6.9). All three expose the
 * same thing: a fresh, isolated Playwright BrowserContext with the network
 * guard installed. The quorum gets engine and location diversity:
 *   kernel-chromium  KERNEL cloud browser over CDP (headful, so it can record a replay)
 *   local-chromium   Chromium on this machine
 *   local-webkit     WebKit (Safari's engine) on this machine
 */

export type BrowserKind = "kernel-chromium" | "local-chromium" | "local-webkit";

export interface SessionOptions {
  network: NetworkPolicy;
  viewport?: { width: number; height: number };
  /** Ask the provider to record a replay video (KERNEL only). */
  replay?: boolean;
}

export interface BrowserSession {
  kind: BrowserKind;
  /** What actually ran, e.g. "local-webkit 26.0"; goes into the signed attestation. */
  label: string;
  context: BrowserContext;
  /** URLs the network guard refused, with reasons. Recorded as evidence. */
  blocked: { url: string; reason: string }[];
  /** Stops recording (if any) and returns the replay link. */
  stopReplay(): Promise<string | undefined>;
  close(): Promise<void>;
}

export interface BrowserProvider {
  kind: BrowserKind;
  open(opts: SessionOptions): Promise<BrowserSession>;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

/**
 * Fresh context + request-level guard. For local browsers this is the second
 * layer: the egress proxy (which also sees every redirect hop) is the first.
 *
 * `fetchViaProxy` (local WebKit): WebKit on macOS connects to loopback addresses
 * directly, ignoring the proxy, and routes never see redirect hops. A deliverable
 * could then redirect the browser (even inside HTTPS, where the proxy cannot read
 * the 302) into a service on the verifier's own machine. So for WebKit every
 * request is fetched by Playwright on the Node side through the egress proxy,
 * following redirects there (each hop is its own checked tunnel), and the browser
 * only receives the final response.
 */
async function prepareContext(
  browser: Browser,
  opts: SessionOptions,
  reuseDefault = false,
  blocked: BrowserSession["blocked"] = [],
  fetchViaProxy = false,
) {
  const context =
    reuseDefault && browser.contexts()[0]
      ? browser.contexts()[0]!
      : await browser.newContext({
          viewport: opts.viewport ?? DEFAULT_VIEWPORT,
          acceptDownloads: false,
          serviceWorkers: "block",
          ignoreHTTPSErrors: false,
        });
  if (reuseDefault) await context.pages()[0]?.setViewportSize(opts.viewport ?? DEFAULT_VIEWPORT);
  const cache = new Map<string, Promise<Awaited<ReturnType<typeof checkUrl>>>>();
  const guard = (url: string) => {
    const key = (() => {
      try {
        return new URL(url).origin;
      } catch {
        return url;
      }
    })();
    if (!cache.has(key)) cache.set(key, checkUrl(url, opts.network));
    return cache.get(key)!;
  };
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (!/^https?:/i.test(url)) return route.continue();
    const res = await guard(url);
    if (!res.ok) {
      blocked.push({ url, reason: res.reason });
      return route.abort("blockedbyclient");
    }
    if (!fetchViaProxy) return route.continue();
    const before = blocked.length;
    let response;
    try {
      response = await route.fetch();
    } catch {
      // The proxy refused a hop (it records why in `blocked`) or the network failed.
      return route.abort(blocked.length > before ? "blockedbyclient" : "failed").catch(() => undefined);
    }
    return route.fulfill({ response }).catch(() => undefined);
  });
  await context.routeWebSocket(/.*/, async (ws) => {
    const url = ws.url().replace(/^ws/, "http");
    const res = await guard(url);
    if (res.ok) ws.connectToServer();
    else {
      blocked.push({ url: ws.url(), reason: res.reason });
      await ws.close({ code: 1008, reason: "blocked by verifier" });
    }
  });
  return { context, blocked };
}

function localProvider(kind: "local-chromium" | "local-webkit"): BrowserProvider {
  const engine = kind === "local-chromium" ? chromium : webkit;
  return {
    kind,
    async open(opts) {
      const blocked: BrowserSession["blocked"] = [];
      const proxy = await startEgressProxy(opts.network, blocked);
      let browser: Browser;
      try {
        browser = await engine.launch({
          headless: true,
          proxy: { server: proxy.url },
          // Chromium sends loopback traffic around a proxy unless told not to; we want every request checked.
          args: kind === "local-chromium" ? ["--proxy-bypass-list=<-loopback>"] : [],
        });
      } catch (err) {
        await proxy.close();
        const msg = err instanceof Error ? err.message : String(err);
        if (/Executable doesn't exist|playwright install/i.test(msg)) {
          const name = kind === "local-chromium" ? "chromium" : "webkit";
          throw new Error(`${kind} is not installed. Run: npx playwright install ${name}`, { cause: err });
        }
        throw err;
      }
      const { context } = await prepareContext(browser, opts, false, blocked, kind === "local-webkit");
      return {
        kind,
        label: `${kind} ${browser.version()}`,
        context,
        blocked,
        stopReplay: async () => undefined,
        close: async () => {
          await browser.close().catch(() => undefined);
          await proxy.close();
        },
      };
    },
  };
}

export const localChromium = (): BrowserProvider => localProvider("local-chromium");
export const localWebkit = (): BrowserProvider => localProvider("local-webkit");

export function kernelChromium(apiKey: string): BrowserProvider {
  const kernel = new Kernel({ apiKey });
  return {
    kind: "kernel-chromium",
    async open(opts) {
      // Headful sessions support replays (KERNEL docs); a timeout stops a forgotten session billing forever.
      const session = await kernel.browsers.create({ headless: !opts.replay, timeout_seconds: 300 });
      let browser: Browser | undefined;
      try {
        browser = await chromium.connectOverCDP(session.cdp_ws_url);
        const { context, blocked } = await prepareContext(browser, opts, true);
        let replayId: string | undefined;
        if (opts.replay) {
          try {
            replayId = (await kernel.browsers.replays.start(session.session_id)).replay_id;
          } catch {
            replayId = undefined; // replays are a bonus; never fail verification over them
          }
        }
        return {
          kind: "kernel-chromium",
          label: `kernel-chromium ${browser.version()} (session ${session.session_id})`,
          context,
          blocked,
          async stopReplay() {
            if (!replayId) return undefined;
            await kernel.browsers.replays.stop(replayId, { id_or_name: session.session_id }).catch(() => undefined);
            const list = await kernel.browsers.replays.list(session.session_id).catch(() => []);
            return list.find((r) => r.replay_id === replayId)?.replay_view_url;
          },
          async close() {
            await browser?.close().catch(() => undefined);
            await kernel.browsers.deleteByID(session.session_id).catch(() => undefined);
          },
        };
      } catch (err) {
        await browser?.close().catch(() => undefined);
        await kernel.browsers.deleteByID(session.session_id).catch(() => undefined);
        throw err;
      }
    },
  };
}

export interface PanelSlot {
  verifierId: string;
  provider: BrowserProvider;
  /** Set when the slot had to use a different browser than planned, and why. */
  fallback?: string;
}

/**
 * Browser for each verifier slot: a → KERNEL (if configured and the deliverable
 * is publicly reachable), b → local Chromium, c → local WebKit, then alternating.
 */
export function panelBrowsers(
  verifierIds: readonly string[],
  opts: { kernelApiKey?: string; preferKernel: boolean; deliverableUrl: string },
): PanelSlot[] {
  return verifierIds.map((verifierId, idx) => {
    if (idx === 0) {
      if (!opts.preferKernel) return { verifierId, provider: localChromium() };
      if (!opts.kernelApiKey) return { verifierId, provider: localChromium(), fallback: "no KERNEL_API_KEY" };
      if (!isPubliclyReachable(opts.deliverableUrl)) {
        return { verifierId, provider: localChromium(), fallback: "deliverable is not reachable from a cloud browser" };
      }
      return { verifierId, provider: kernelChromium(opts.kernelApiKey) };
    }
    return { verifierId, provider: idx % 2 === 1 ? localChromium() : localWebkit() };
  });
}
