import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * A thin MCP client for the demo agents: connects to a Kept server as one
 * party and calls its tools. Everything goes through MCP, exactly as an
 * off-the-shelf agent would do it.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolData = Record<string, any>;

export class ToolError extends Error {
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(`${tool}: ${message}`);
    this.name = "ToolError";
  }
}

export interface KeptAgent {
  readonly name: string;
  readonly partyId: string;
  call(tool: string, args?: Record<string, unknown>): Promise<ToolData>;
  close(): Promise<void>;
}

/** verify waits for three browsers; give it far longer than the SDK's 60 s default. */
const SLOW_TOOLS: Record<string, number> = { verify: 600_000, settle: 120_000, lock_funds: 60_000, confirm_funds: 60_000 };

export async function connectAgent(baseUrl: string, token: string, name: string): Promise<KeptAgent> {
  const client = new Client({ name: `kept-${name}-agent`, version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<ToolData> => {
    const res = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: SLOW_TOOLS[tool] ?? 60_000 })) as CallToolResult;
    const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    if (res.isError) throw new ToolError(tool, text);
    return (res.structuredContent as ToolData | undefined) ?? (JSON.parse(text) as ToolData);
  };
  const me = await call("whoami");
  return { name, partyId: me.party_id as string, call, close: () => client.close() };
}

export type Log = (line: string) => void;

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

export const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Reads `--name value` from argv. */
export function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
