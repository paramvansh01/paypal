import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/client.js";
import { parties } from "../src/db/schema.js";
import { DEMO_CLIENT_ID, DEMO_WORKER_ID, seedDemoParties } from "../src/db/seed.js";
import { MCP_TOOLS } from "../src/mcp/server.js";
import { loadKeyring } from "../src/qaps/keys.js";
import { verifierIds } from "../src/qaps/protocol.js";
import { ISSUER_ID, verifyReceipt } from "../src/qaps/receipt.js";
import { createApp, type AppDeps } from "../src/server/app.js";
import { partyToken } from "../src/server/auth.js";
import { buildVerifier } from "../src/server/verifier.js";
import { EvidenceStore } from "../src/verifier/evidence-store.js";
import { MockRail } from "./helpers/qaps.js";

const SECRET = "mcp-test-secret-0123456789";
const STRANGER = "party_stranger";
const ROOT = join(import.meta.dirname, "..");
const keyring = loadKeyring(verifierIds(3), { dir: mkdtempSync(join(tmpdir(), "kept-mcp-keys-")) });
const issuer = loadKeyring([ISSUER_ID], { dir: mkdtempSync(join(tmpdir(), "kept-mcp-issuer-")) }).get(ISSUER_ID)!;
const store = new EvidenceStore(mkdtempSync(join(tmpdir(), "kept-mcp-ev-")));
const CONTRACT = JSON.parse(readFileSync(new URL("../demo/contract.json", import.meta.url), "utf8")) as { total_cents: number };

let server: Server;
let base: string;
let db: Db;
let rail: MockRail;
const holder: { app?: ReturnType<typeof createApp> } = {};
const open: Client[] = [];

function config(env: Record<string, string> = {}) {
  return loadConfig({ MCP_AUTH_TOKEN: SECRET, PUBLIC_BASE_URL: base, PORT: new URL(base).port, ...env });
}
function rebuild(over: Partial<AppDeps> = {}, env: Record<string, string> = {}) {
  db = openDb(":memory:");
  seedDemoParties(db, loadConfig({ DEMO_CLIENT_EMAIL: "c@example.com", DEMO_WORKER_EMAIL: "w@example.com" }));
  db.insert(parties).values({ id: STRANGER, kind: "agent", displayName: "Someone else" }).run();
  rail = new MockRail();
  holder.app = createApp(config(env), { db, keyring, issuer, evidence: store, rail, ...over });
}

beforeAll(async () => {
  server = createServer((req, res) => holder.app!(req, res)).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await Promise.all(open.map((c) => c.close()));
  await new Promise((r) => server.close(r));
});
beforeEach(() => rebuild());

/** A real MCP client over Streamable HTTP, acting as one party. */
async function connect(party: string, token = partyToken(SECRET, party)): Promise<Client> {
  const client = new Client({ name: `test-${party}`, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  open.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  return { isError: res.isError === true, text, data: res.structuredContent as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
async function must(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await call(client, name, args);
  expect(r.isError, `${name}: ${r.text}`).toBe(false);
  return r.data;
}

const jobArgs = (checklist: unknown = CONTRACT) => ({
  title: "Halcyon Crumb website",
  brief: "A bakery website with a menu and a working contact form.",
  worker_id: DEMO_WORKER_ID,
  budget_cents: CONTRACT.total_cents,
  checklist,
});

describe("MCP server over Streamable HTTP (/mcp)", () => {
  it("needs a valid party token; GET is refused (stateless server)", async () => {
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } };
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    expect((await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(init) })).status).toBe(401);
    const forged = `${DEMO_CLIENT_ID}.${"0".repeat(64)}`;
    expect((await fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, authorization: `Bearer ${forged}` }, body: JSON.stringify(init) })).status).toBe(401);
    await expect(connect(DEMO_CLIENT_ID, forged)).rejects.toThrow();
    expect((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${partyToken(SECRET, DEMO_CLIENT_ID)}` } })).status).toBe(405);

    rebuild({}, { MCP_AUTH_TOKEN: "" });
    expect((await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(init) })).status).toBe(503);
  });

  it("lists every tool in section 6.8 with a description and an input schema, and explains the lifecycle", async () => {
    const client = await connect(DEMO_CLIENT_ID);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOLS].sort());
    for (const t of tools) {
      expect(t.description?.length, t.name).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe("object");
    }
    // The contract format is spelled out for agents: check types are an enum in post_job's schema.
    const post = JSON.stringify(tools.find((t) => t.name === "post_job")!.inputSchema);
    for (const type of ["http_status", "form_submits", "client_approval", "llm_judgement"]) expect(post).toContain(type);
    expect(client.getInstructions()).toMatch(/approval link/);
    expect(await must(client, "whoami")).toMatchObject({ party_id: DEMO_CLIENT_ID, kind: "human" });
  });

  it("the party comes from the token: role rules and the state machine apply exactly as in the REST API", async () => {
    const client = await connect(DEMO_CLIENT_ID);
    const worker = await connect(DEMO_WORKER_ID);
    const stranger = await connect(STRANGER);
    const job = await must(client, "post_job", jobArgs());
    expect(job.status).toBe("CHECKLIST_PROPOSED");

    // A job is always posted with the caller as the client, so the worker cannot hire itself.
    const wrong = await call(worker, "post_job", { ...jobArgs(), worker_id: DEMO_WORKER_ID });
    expect(wrong).toMatchObject({ isError: true });
    expect(wrong.text).toMatch(/^Invalid input: worker_id must be a different party/);

    const stale = await call(worker, "accept_checklist", { job_id: job.id, checklist_hash: "0".repeat(64) });
    expect(stale.isError).toBe(true);
    expect(stale.text).toMatch(/the checklist changed/);
    const outsider = await call(stranger, "accept_checklist", { job_id: job.id, checklist_hash: job.checklist_hash });
    expect(outsider.text).toMatch(/^Not allowed: Only the client or worker/);

    expect(await must(client, "accept_checklist", { job_id: job.id, checklist_hash: job.checklist_hash })).toMatchObject({ agreed: false });
    expect(await must(worker, "accept_checklist", { job_id: job.id, checklist_hash: job.checklist_hash })).toMatchObject({ agreed: true });

    expect((await call(worker, "lock_funds", { job_id: job.id })).text).toMatch(/^Not allowed: Only the client/);
    expect((await call(client, "submit_work", { job_id: job.id, deliverable_url: `${base}/demo/sites/good/` })).text).toMatch(/^Not allowed: Only the worker/);
    expect((await call(client, "get_job", { job_id: "job_nope" })).text).toMatch(/^Not found/);
    // Schema validation happens before the tool runs.
    expect((await call(client, "accept_checklist", { job_id: job.id, checklist_hash: "nothex" })).isError).toBe(true);

    const listed = await must(worker, "list_jobs");
    expect(listed.jobs.map((j: { id: string }) => j.id)).toEqual([job.id]);
    expect((await must(stranger, "list_jobs")).jobs).toEqual([]);
  });

  it("without a PayPal rail, money tools say so instead of failing obscurely", async () => {
    rebuild({ rail: undefined });
    const client = await connect(DEMO_CLIENT_ID);
    const worker = await connect(DEMO_WORKER_ID);
    const job = await must(client, "post_job", jobArgs());
    await must(client, "accept_checklist", { job_id: job.id, checklist_hash: job.checklist_hash });
    await must(worker, "accept_checklist", { job_id: job.id, checklist_hash: job.checklist_hash });
    const r = await call(client, "lock_funds", { job_id: job.id });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Unavailable: No PayPal rail .*T2\.3/);
    expect((await call(client, "get_receipt", { job_id: job.id })).text).toMatch(/^Conflict: /);
  });

  it("two agents run a whole job on the flawed site: 3 milestones released, 1 refunded, receipt verifies", async () => {
    rebuild({ verify: buildVerifier(config(), keyring, store) });
    const client = await connect(DEMO_CLIENT_ID);
    const worker = await connect(DEMO_WORKER_ID);

    const job = await must(client, "post_job", jobArgs());
    await must(client, "accept_checklist", { job_id: job.id, checklist_hash: job.checklist_hash });
    await must(worker, "accept_checklist", { job_id: job.id, checklist_hash: job.checklist_hash });
    const lock = await must(client, "lock_funds", { job_id: job.id });
    expect(lock.approve_url).toMatch(/^https?:/);
    expect(await must(client, "confirm_funds", { job_id: job.id })).toMatchObject({ status: "FUNDED" });
    await must(worker, "submit_work", { job_id: job.id, deliverable_url: `${base}/demo/sites/flawed/` });

    const v = await must(worker, "verify", { job_id: job.id });
    expect(v.status).toBe("verified");
    expect(v.certificate_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(v.milestone_outcomes).toEqual(["passed", "passed", "failed", "passed"]);
    expect(v.verifiers).toHaveLength(3);
    expect(v.job.status).toBe("VERIFIED");

    const s = await must(client, "settle", { job_id: job.id });
    expect(s.job.status).toBe("SETTLED");
    expect(s.job.milestones.map((m: { status: string }) => m.status)).toEqual(["released", "released", "refunded", "released"]);
    expect(rail.moved.filter((x) => x.kind === "release")).toHaveLength(3);
    expect(rail.moved.filter((x) => x.kind === "refund")).toHaveLength(1);
    // Settling again moves nothing.
    await call(worker, "settle", { job_id: job.id });
    expect(rail.moved.filter((x) => x.kind !== "finalize")).toHaveLength(4);

    const receipt = await must(worker, "get_receipt", { job_id: job.id });
    const check = verifyReceipt(receipt, { issuerFingerprint: issuer.public.fingerprint });
    expect(check.checks.filter((c) => !c.ok)).toEqual([]);
    expect(receipt.contract_hash).toBe(job.checklist_hash);
  }, 120_000);
});

describe("MCP server over stdio", () => {
  const tmp = mkdtempSync(join(tmpdir(), "kept-mcp-stdio-"));
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    MCP_AUTH_TOKEN: SECRET,
    DATABASE_PATH: join(tmp, "kept.db"),
    VERIFIER_KEYS_DIR: join(tmp, "keys"),
    EVIDENCE_DIR: join(tmp, "evidence"),
    DEMO_CLIENT_EMAIL: "c@example.com",
    DEMO_WORKER_EMAIL: "w@example.com",
  };
  const tsx = join(ROOT, "node_modules/.bin/tsx");

  beforeAll(() => {
    const seeded = openDb(env.DATABASE_PATH);
    seedDemoParties(seeded, loadConfig(env));
  });

  it("acts as the party in KEPT_PARTY_TOKEN, with nothing but protocol on stdout", async () => {
    const client = new Client({ name: "stdio-test", version: "1.0.0" });
    const transport = new StdioClientTransport({ command: tsx, args: [join(ROOT, "src/mcp/stdio.ts")], cwd: tmp, env: { ...env, KEPT_PARTY_TOKEN: partyToken(SECRET, DEMO_CLIENT_ID) }, stderr: "pipe" });
    await client.connect(transport);
    try {
      expect((await client.listTools()).tools).toHaveLength(MCP_TOOLS.length);
      expect(await must(client, "whoami")).toMatchObject({ party_id: DEMO_CLIENT_ID });
      const job = await must(client, "post_job", jobArgs());
      expect((await must(client, "list_jobs")).jobs.map((j: { id: string }) => j.id)).toEqual([job.id]);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("refuses to start with a bad token, saying why on stderr", () => {
    let out: { status: number | null; stderr: string } = { status: 0, stderr: "" };
    try {
      execFileSync(tsx, [join(ROOT, "src/mcp/stdio.ts")], { cwd: tmp, env: { ...env, KEPT_PARTY_TOKEN: partyToken("other-secret", DEMO_CLIENT_ID) }, stdio: "pipe" });
    } catch (e) {
      out = e as { status: number; stderr: string };
    }
    expect(out.status).toBe(1);
    expect(String(out.stderr)).toMatch(/KEPT_PARTY_TOKEN is not a valid party token/);
  }, 30_000);
});
