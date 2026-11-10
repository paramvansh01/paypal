import { lookup } from "node:dns/promises";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { connect, isIP, type AddressInfo, type Socket } from "node:net";
import { isBlockedIp, type NetworkPolicy } from "./url-guard.js";

/**
 * Egress proxy for local verifier browsers.
 *
 * Every connection the browser makes (each redirect hop, HTTPS and WSS
 * tunnels, plain websockets) goes through here. The proxy resolves the host,
 * checks the address, and connects to exactly the address it checked, so a
 * redirect into 169.254.169.254 or a DNS answer that changes between check and
 * connect (DNS rebinding) cannot reach a private network.
 */

export interface EgressProxy {
  /** e.g. "http://127.0.0.1:53211" — pass to Playwright's `proxy.server`. */
  url: string;
  blocked: { url: string; reason: string }[];
  close(): Promise<void>;
}

type Decision = { ok: true; address: string } | { ok: false; reason: string };

async function decide(scheme: "http" | "https" | "tunnel", hostname: string, port: number, policy: NetworkPolicy): Promise<Decision> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const originFor = (s: "http" | "https") =>
    `${s}://${host.includes(":") ? `[${host}]` : host}${port === (s === "https" ? 443 : 80) ? "" : `:${port}`}`;
  // A CONNECT tunnel names only host:port, not the scheme inside it. Playwright's own fetcher
  // (route.fetch) tunnels plain http too, so an allowed origin of either scheme opens the tunnel.
  const allowed =
    scheme === "tunnel"
      ? policy.allowOrigins.includes(originFor("https")) || policy.allowOrigins.includes(originFor("http"))
      : policy.allowOrigins.includes(originFor(scheme));

  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = policy.resolve
        ? await policy.resolve(host)
        : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      return { ok: false, reason: `${host} does not resolve` };
    }
  }
  if (addresses.length === 0) return { ok: false, reason: `${host} does not resolve` };
  if (allowed) return { ok: true, address: addresses[0]! };
  if (!isIP(host) && (host === "localhost" || /\.(localhost|local|internal)$/.test(host))) {
    return { ok: false, reason: `${host} is a local hostname` };
  }
  const bad = addresses.find(isBlockedIp);
  if (bad) return { ok: false, reason: isIP(host) ? `${host} is a private or reserved address` : `${host} resolves to private address ${bad}` };
  return { ok: true, address: addresses[0]! };
}

const HOP_BY_HOP = ["proxy-connection", "proxy-authorization", "connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"];

export async function startEgressProxy(policy: NetworkPolicy, sink: EgressProxy["blocked"] = []): Promise<EgressProxy> {
  const blocked = sink;
  const sockets = new Set<Socket>();

  const server = createServer(async (req, res) => {
    // Plain HTTP through a proxy: the request line carries the absolute URL.
    let target: URL;
    try {
      target = new URL(req.url ?? "");
      if (target.protocol !== "http:") throw new Error();
    } catch {
      res.writeHead(400).end("Kept egress proxy: absolute http:// URL required");
      return;
    }
    const port = Number(target.port || 80);
    const d = await decide("http", target.hostname, port, policy);
    if (!d.ok) {
      blocked.push({ url: target.href, reason: d.reason });
      res.writeHead(403, { "content-type": "text/plain" }).end(`Blocked by Kept verifier: ${d.reason}`);
      return;
    }
    const headers = { ...req.headers };
    for (const h of HOP_BY_HOP) delete headers[h];
    // RFC 7230 §5.4: with an absolute-form request target, Host comes from the URL.
    headers.host = target.host;
    const upstream = httpRequest(
      { host: d.address, port, method: req.method, path: `${target.pathname}${target.search}`, headers, setHost: false },
      async (up) => {
        // Check redirect targets here too. Some browsers (WebKit on macOS 26) connect to loopback
        // directly instead of through this proxy, and Playwright routes miss redirect hops, so a
        // redirect into 127.0.0.1 would otherwise reach a local service unchecked.
        const location = up.headers.location;
        const status = up.statusCode ?? 502;
        if (status >= 300 && status < 400 && typeof location === "string") {
          let next: URL | undefined;
          try {
            next = new URL(location, target);
          } catch {
            next = undefined;
          }
          if (next && (next.protocol === "http:" || next.protocol === "https:")) {
            const scheme = next.protocol === "https:" ? "https" : "http";
            const nd = await decide(scheme, next.hostname, Number(next.port || (scheme === "https" ? 443 : 80)), policy);
            if (!nd.ok) {
              up.resume();
              blocked.push({ url: next.href, reason: nd.reason });
              res.writeHead(403, { "content-type": "text/plain" }).end(`Blocked by Kept verifier: ${nd.reason}`);
              return;
            }
          }
        }
        res.writeHead(status, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502).end("Kept egress proxy: upstream error");
      else res.destroy();
    });
    req.pipe(upstream);
  });

  // HTTPS and WSS: CONNECT host:port, then a raw tunnel to the checked address.
  server.on("connect", async (req: IncomingMessage, client: Socket, head: Buffer) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => undefined);
    const m = (req.url ?? "").match(/^\[?([^\]]+?)\]?:(\d+)$/);
    if (!m) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const [, host, portStr] = m;
    const port = Number(portStr);
    const d = await decide("tunnel", host!, port, policy);
    if (!d.ok) {
      blocked.push({ url: `https://${req.url}`, reason: d.reason });
      client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nBlocked by Kept verifier: ${d.reason}`);
      return;
    }
    const upstream = connect(port, d.address, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => client.destroy());
  });

  // Plain ws:// through the proxy arrives as an Upgrade request with an absolute URL.
  server.on("upgrade", async (req: IncomingMessage, client: Socket, head: Buffer) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => undefined);
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const port = Number(target.port || 80);
    const d = await decide("http", target.hostname, port, policy);
    if (!d.ok) {
      blocked.push({ url: target.href.replace(/^http/, "ws"), reason: d.reason });
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = connect(port, d.address, () => {
      const lines = [`${req.method} ${target.pathname}${target.search} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (!/^proxy-/i.test(req.rawHeaders[i]!)) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => client.destroy());
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    blocked,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
