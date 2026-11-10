import { createServer, request, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEgressProxy, type EgressProxy } from "../src/verifier/egress-proxy.js";

let upstream: Server;
let upstreamPort: number;
const received: { url?: string; host?: string; proxyHeader?: string }[] = [];

beforeAll(async () => {
  upstream = createServer((req, res) => {
    received.push({ url: req.url, host: req.headers.host, proxyHeader: req.headers["proxy-authorization"] as string | undefined });
    res.writeHead(200, { "content-type": "text/plain" }).end("upstream ok");
  });
  upstream.on("upgrade", (_req, socket) => {
    socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => upstream.close(() => r())));

/** Sends one plain-HTTP request through the proxy. */
function viaProxy(proxy: EgressProxy, url: string, headers: Record<string, string> = {}) {
  const p = new URL(proxy.url);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: p.hostname, port: p.port, method: "GET", path: url, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Sends a raw request line + headers and returns the first response line. */
function raw(proxy: EgressProxy, text: string) {
  const p = new URL(proxy.url);
  return new Promise<string>((resolve) => {
    const s = connect(Number(p.port), p.hostname, () => s.write(text));
    let buf = "";
    s.on("data", (d) => {
      buf += d;
      if (buf.includes("\r\n")) {
        resolve(buf.split("\r\n")[0]!);
        s.destroy();
      }
    });
    s.on("close", () => resolve(buf.split("\r\n")[0] ?? ""));
  });
}

describe("egress proxy", () => {
  it("forwards allowed origins and strips proxy headers", async () => {
    const proxy = await startEgressProxy({ allowOrigins: [`http://127.0.0.1:${upstreamPort}`] });
    try {
      const res = await viaProxy(proxy, `http://127.0.0.1:${upstreamPort}/hello?x=1`, { "proxy-authorization": "secret" });
      expect(res).toEqual({ status: 200, body: "upstream ok" });
      expect(received.at(-1)).toEqual({ url: "/hello?x=1", host: `127.0.0.1:${upstreamPort}`, proxyHeader: undefined });
      expect(proxy.blocked).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  it("blocks private addresses with a 403 and logs them", async () => {
    const proxy = await startEgressProxy({ allowOrigins: [] });
    try {
      const res = await viaProxy(proxy, "http://169.254.169.254/latest/meta-data/");
      expect(res.status).toBe(403);
      expect(res.body).toMatch(/Blocked by Kept verifier: 169\.254\.169\.254 is a private or reserved address/);
      expect(proxy.blocked).toEqual([{ url: "http://169.254.169.254/latest/meta-data/", reason: "169.254.169.254 is a private or reserved address" }]);
    } finally {
      await proxy.close();
    }
  });

  it("defeats DNS rebinding: resolves once and connects to exactly the address it checked", async () => {
    // First answer: our upstream (allowed origin). Any later answer: a private address.
    let calls = 0;
    const resolve = async () => (calls++ === 0 ? ["127.0.0.1"] : ["10.9.9.9"]);
    const proxy = await startEgressProxy({ allowOrigins: [`http://good.example:${upstreamPort}`], resolve });
    try {
      const res = await viaProxy(proxy, `http://good.example:${upstreamPort}/rebind`);
      expect(res).toEqual({ status: 200, body: "upstream ok" });
      expect(calls).toBe(1);
      expect(received.at(-1)).toMatchObject({ url: "/rebind", host: `good.example:${upstreamPort}` });
    } finally {
      await proxy.close();
    }
  });

  it("blocks a public hostname whose answer is private", async () => {
    const proxy = await startEgressProxy({ allowOrigins: [], resolve: async () => ["127.0.0.1"] });
    try {
      expect((await viaProxy(proxy, `http://rebind.example:${upstreamPort}/`)).status).toBe(403);
      expect(proxy.blocked[0]!.reason).toBe("rebind.example resolves to private address 127.0.0.1");
    } finally {
      await proxy.close();
    }
  });

  it("blocks HTTPS tunnels to private addresses", async () => {
    const proxy = await startEgressProxy({ allowOrigins: [] });
    try {
      const line = await raw(proxy, "CONNECT 10.0.0.5:443 HTTP/1.1\r\nHost: 10.0.0.5:443\r\n\r\n");
      expect(line).toBe("HTTP/1.1 403 Forbidden");
      expect(proxy.blocked[0]).toEqual({ url: "https://10.0.0.5:443", reason: "10.0.0.5 is a private or reserved address" });
      const v6 = await raw(proxy, "CONNECT [::1]:443 HTTP/1.1\r\nHost: [::1]:443\r\n\r\n");
      expect(v6).toBe("HTTP/1.1 403 Forbidden");
    } finally {
      await proxy.close();
    }
  });

  it("opens tunnels to allowed origins", async () => {
    const proxy = await startEgressProxy({ allowOrigins: [`https://127.0.0.1:${upstreamPort}`] });
    try {
      const line = await raw(proxy, `CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
      expect(line).toBe("HTTP/1.1 200 Connection Established");
    } finally {
      await proxy.close();
    }
  });

  it("checks plain websocket upgrades too", async () => {
    const proxy = await startEgressProxy({ allowOrigins: [`http://127.0.0.1:${upstreamPort}`] });
    try {
      const upgrade = (host: string) =>
        `GET http://${host}/socket HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`;
      expect(await raw(proxy, upgrade("192.168.1.1"))).toBe("HTTP/1.1 403 Forbidden");
      expect(await raw(proxy, upgrade(`127.0.0.1:${upstreamPort}`))).toBe("HTTP/1.1 101 Switching Protocols");
    } finally {
      await proxy.close();
    }
  });

  it("only listens on loopback", async () => {
    const proxy = await startEgressProxy({ allowOrigins: [] });
    try {
      expect(new URL(proxy.url).hostname).toBe("127.0.0.1");
    } finally {
      await proxy.close();
    }
  });
});
