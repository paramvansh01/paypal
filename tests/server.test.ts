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

  it("GET / serves the placeholder page", async () => {
    const res = await fetch(base);
    expect(res.headers.get("content-type")).toMatch(/html/);
    expect(await res.text()).toContain("Kept");
  });
});
