import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server/app.js";

let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp(loadConfig({})).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

describe("server", () => {
  it("GET /health returns ok", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "kept" });
  });

  it("GET / serves the web app", async () => {
    const res = await fetch(base);
    expect(res.headers.get("content-type")).toMatch(/html/);
    expect(await res.text()).toContain("Kept");
  });
});

describe("GET /evidence/:hash", () => {
  it("serves stored artifacts by hash and nothing else", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { EvidenceStore } = await import("../src/verifier/evidence-store.js");
    const store = new EvidenceStore(mkdtempSync(join(tmpdir(), "kept-srv-ev-")));
    const { sha256 } = store.put('{"a":1}', "json");
    const srv = createApp(loadConfig({}), { evidence: store }).listen(0);
    await new Promise((r) => srv.once("listening", r));
    const b = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      const ok = await fetch(`${b}/evidence/${sha256}.json`);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe('{"a":1}');
      expect((await fetch(`${b}/evidence/${"0".repeat(64)}.json`)).status).toBe(404);
      expect((await fetch(`${b}/evidence/..%2f..%2fetc%2fpasswd`)).status).toBe(404);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});
