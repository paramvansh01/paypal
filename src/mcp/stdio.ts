/**
 * Kept MCP server over stdio, for local desktop clients (Claude Code, Claude Desktop).
 *
 *   KEPT_PARTY_TOKEN=<token from `npm run party-token -- <party_id>`> node_modules/.bin/tsx src/mcp/stdio.ts
 *
 * It acts as the party the token belongs to and uses the same database, keys
 * and verifier settings as the web server (.env). stdout carries the protocol,
 * so every log line goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "../config.js";
import { getParty } from "../core/jobs.js";
import { KeyError } from "../qaps/keys.js";
import { partyFromToken } from "../server/auth.js";
import { loadServices } from "../server/services.js";
import { createMcpServer } from "./server.js";

console.log = console.error; // never write anything but protocol messages to stdout
console.info = console.error;

function die(message: string): never {
  console.error(`kept-mcp: ${message}`);
  process.exit(1);
}

try {
  const config = loadConfig();
  const secret = config.app.mcpAuthToken;
  if (!secret) die("MCP_AUTH_TOKEN is not set (see .env.example).");
  const token = process.env.KEPT_PARTY_TOKEN;
  if (!token) die("KEPT_PARTY_TOKEN is not set. Get one with `npm run party-token -- <party_id>`.");
  const services = loadServices(config);
  const partyId = partyFromToken(secret, token);
  const party = partyId ? getParty(services.db, partyId) : undefined;
  if (!party) die("KEPT_PARTY_TOKEN is not a valid party token for this server (wrong MCP_AUTH_TOKEN, or the party does not exist; run `npm run seed`).");
  const server = createMcpServer(config, services, party);
  await server.connect(new StdioServerTransport());
  console.error(`kept-mcp: ready on stdio as ${party.id} (${party.displayName})`);
} catch (err) {
  if (err instanceof ConfigError || err instanceof KeyError) die(err.message);
  throw err;
}
