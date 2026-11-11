import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/client.js";
import { DEMO_CLIENT_ID, DEMO_WORKER_ID, seedDemoParties } from "../src/db/seed.js";
import { ChecklistGenerationError, draftFromModel, generateChecklist } from "../src/llm/checklist-gen.js";
import { ScriptedLlm } from "../src/llm/client.js";
import { loadKeyring } from "../src/qaps/keys.js";
import { verifierIds } from "../src/qaps/protocol.js";
import { createApp, type AppDeps } from "../src/server/app.js";
import { partyToken } from "../src/server/auth.js";

const input = { brief: "A one-page site for a cafe with opening hours and a contact form.", budgetCents: 6000, currency: "USD" };
const item = (check_type: string, params: unknown, description = "x") => ({ description, check_type, params_json: JSON.stringify(params) });
const good = {
  milestones: [
    { title: "Page live", amount_cents: 3000, items: [item("http_status", { path: "/", expected: 200 }), item("text_present", { path: "/", text: "Opening hours" })] },
    { title: "Looks right", amount_cents: 3000, items: [item("llm_judgement", { path: "/", question: "Does the page show opening hours for every weekday?" }), item("client_approval", {})] },
  ],
};

describe("checklist generator", () => {
  it("turns a valid model answer into a contract the schema accepts", () => {
    const c = draftFromModel(good, input);
    expect(c).toMatchObject({ version: 1, currency: "USD", total_cents: 6000 });
    expect(c.milestones[0]!.items[0]).toEqual({ description: "x", check_type: "http_status", params: { path: "/", expected: 200 } });
  });
  it("rejects amounts that do not add up, bad params and unknown check types", () => {
    expect(() => draftFromModel({ milestones: [{ ...good.milestones[0]!, amount_cents: 2999 }, good.milestones[1]] }, input)).toThrow(/add up to 5999/);
    expect(() => draftFromModel({ milestones: [{ title: "a", amount_cents: 6000, items: [item("text_present", { path: "no-slash", text: "x" })] }] }, input)).toThrow(ChecklistGenerationError);
    expect(() => draftFromModel({ milestones: [{ title: "a", amount_cents: 6000, items: [item("run_shell", {})] }] }, input)).toThrow(ChecklistGenerationError);
    expect(() => draftFromModel({ milestones: [{ title: "a", amount_cents: 6000, items: [{ description: "x", check_type: "client_approval", params_json: "{" }] }] }, input)).toThrow(/not JSON/);
  });
  it("tells the model what was wrong and asks once more", async () => {
    let n = 0;
    const llm = new ScriptedLlm(() => JSON.stringify(n++ === 0 ? { milestones: [{ ...good.milestones[0]!, amount_cents: 1 }, good.milestones[1]] } : good));
    const c = await generateChecklist(llm, "claude-opus-5-5", input);
    expect(c.total_cents).toBe(6000);
    expect(llm.calls).toHaveLength(2);
    const second = llm.calls[1]!.content[0]!;
    expect(second.type === "text" && second.text).toMatch(/previous answer was rejected: milestone amounts add up to 3001/);
    expect(llm.calls[0]!.system).toMatch(/client_approval/);
  });
  it("gives up after two invalid answers", async () => {
    await expect(generateChecklist(new ScriptedLlm(() => "not json"), "m", input)).rejects.toThrow(ChecklistGenerationError);
  });
});

describe("AI drafts over REST and MCP", () => {
  const SECRET = "gen-test-secret-0123456789";
  let server: Server;
  let base: string;
  const holder: { app?: ReturnType<typeof createApp> } = {};
  const keyring = loadKeyring(verifierIds(3), { dir: mkdtempSync(join(tmpdir(), "kept-gen-keys-")) });
  const build = (over: Partial<AppDeps>) => {
    const db = openDb(":memory:");
    seedDemoParties(db, loadConfig({ DEMO_CLIENT_EMAIL: "c@example.com", DEMO_WORKER_EMAIL: "w@example.com" }));
    holder.app = createApp(loadConfig({ MCP_AUTH_TOKEN: SECRET, PUBLIC_BASE_URL: base }), { db, keyring, ...over });
  };
  beforeAll(async () => {
    server = createServer((req, res) => holder.app!(req, res)).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${partyToken(SECRET, DEMO_CLIENT_ID)}` }, body: JSON.stringify(body) });

  it("POST /checklists/generate returns a draft, or 503 without a model", async () => {
    build({});
    expect((await post("/checklists/generate", { brief: input.brief, budget_cents: 6000 })).status).toBe(503);
    build({ llm: new ScriptedLlm(() => JSON.stringify(good)) });
    const res = await post("/checklists/generate", { brief: input.brief, budget_cents: 6000 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checklist: { total_cents: number } };
    expect(body.checklist.total_cents).toBe(6000);
    build({ llm: new ScriptedLlm(() => "nope") });
    expect((await post("/checklists/generate", { brief: input.brief, budget_cents: 6000 })).status).toBe(422);
  });

  it("MCP post_job without a checklist proposes an AI draft both parties can accept", async () => {
    build({ llm: new ScriptedLlm(() => JSON.stringify(good)) });
    const client = new Client({ name: "t", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${partyToken(SECRET, DEMO_CLIENT_ID)}` } } }));
    const res = (await client.callTool({ name: "post_job", arguments: { title: "Cafe site", brief: input.brief, worker_id: DEMO_WORKER_ID, budget_cents: 6000 } })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    const job = res.structuredContent as { status: string; checklist_hash: string; checklist_source: string; checklist: { milestones: unknown[] } };
    expect(job.status).toBe("CHECKLIST_PROPOSED");
    expect(job.checklist.milestones).toHaveLength(2);
    expect(job.checklist_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(job.checklist_source).toMatch(/AI draft/);
    await client.close();
  });
});
