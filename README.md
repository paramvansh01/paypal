# Kept

**Money that checks the work before it moves.**

Cards let you pay. Instant payment networks let you pay anyone, instantly. **Kept lets you pay *only if*.**

Kept introduces **Proof-Carrying Payments**: a payment that carries its own acceptance test, settled on PayPal.

1. A client (an AI agent or a person) and a worker agree a machine-checkable contract. Its SHA-256 fingerprint is stamped on the PayPal order.
2. The client's money is locked through PayPal. PayPal holds the funds, not Kept.
3. The worker delivers.
4. A **quorum of independent verifier agents** checks the deliverable. Each one uses its own browser engine and its own AI judge, watches for prompt-injection attacks, and signs a Merkle tree of everything it saw.
5. PayPal releases each milestone the quorum agrees passed, and refunds each one that failed.
6. Every settlement comes with a **Proof Receipt** that anyone can verify offline with one command.

The settlement algorithm is **QAPS (Quorum-Attested Proof Settlement)**: fingerprinted contracts + a k-of-n verifier quorum + prompt-injection tripwires + Merkle-signed evidence + settlement that re-verifies everything before money moves. Kept ships as an open protocol, a REST API and an **MCP server**, so any agent can hire, deliver and get paid without custom glue code.

> Status: early build. This README is filled in as features land. Hosted demo link: _coming soon_.

## Prerequisites

- Node.js 20 or newer
- A PayPal Developer account with a sandbox REST app (Platform / Marketplace type), one personal sandbox account and one business sandbox account
- An Anthropic API key
- Optional: a KERNEL API key for cloud browsers. Without one, set `VERIFIER_BROWSER=local` and the verifier uses Chromium on your machine

## Setup

```bash
git clone <repo-url> kept
cd kept
npm install
npx playwright install chromium webkit   # the verifier quorum uses both engines
cp .env.example .env              # then fill in the values (each key is explained in the file)
npm run doctor                    # checks every key and service, one line each
npm run seed                      # creates the demo client and worker
```

## Run

```bash
npm run dev
```

Open http://localhost:3000. Health check: http://localhost:3000/health

## Demo walkthrough

_To be written once the end-to-end demo works._

## Connect an AI agent (MCP)

Kept is an MCP server. An agent connects as one **party** (the client who pays, or the worker who delivers), using a party token.

1. Put a long random `MCP_AUTH_TOKEN` in `.env` (for example `openssl rand -hex 32`). Party tokens are derived from it.
2. Print a token for the party the agent will act as:

   ```bash
   npm run party-token -- party_demo_client
   ```

   The demo parties are `party_demo_client` and `party_demo_worker` (created by `npm run seed`).

**Remote (Streamable HTTP)**: start the server with `npm run dev`, then in Claude Code:

```bash
claude mcp add --transport http kept http://localhost:3000/mcp --header "Authorization: Bearer <party token>"
```

Any MCP client that speaks Streamable HTTP works the same way: URL `http://localhost:3000/mcp` (or the hosted URL + `/mcp`), header `Authorization: Bearer <party token>`.

**Local (stdio)**, for Claude Code or Claude Desktop without running the web server. Use absolute paths:

```bash
claude mcp add kept --env KEPT_PARTY_TOKEN=<party token> -- /path/to/kept/node_modules/.bin/tsx /path/to/kept/src/mcp/stdio.ts
```

For Claude Desktop, add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "kept": {
      "command": "/path/to/kept/node_modules/.bin/tsx",
      "args": ["/path/to/kept/src/mcp/stdio.ts"],
      "env": { "KEPT_PARTY_TOKEN": "<party token>" }
    }
  }
}
```

The stdio server reads the same `.env`, database and keys as the web server.

**Try it with the MCP Inspector** (no AI client needed):

```bash
npx @modelcontextprotocol/inspector --cli http://localhost:3000/mcp --transport http --header "Authorization: Bearer <party token>" --method tools/list
```

Tools: `whoami`, `post_job`, `propose_checklist`, `accept_checklist`, `cancel_job`, `lock_funds`, `confirm_funds`, `submit_work`, `verify`, `approve_item`, `settle`, `get_job`, `list_jobs`, `get_receipt`. The server also sends agents a short description of the job lifecycle. A typical run: the client posts a job with a checklist, both parties accept its hash, the client locks funds (a person approves once in PayPal) and confirms, the worker submits a URL, either party runs `verify` then `settle`, and anyone fetches the Proof Receipt.

## Useful commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the server and restart on file changes |
| `npm run doctor` | Check env vars, database, PayPal, the LLM and the verifier browser |
| `npm run seed` | Create or update the demo parties (safe to run more than once) |
| `npm run check` | Typecheck, lint and run the tests (about 50 s; opens real browsers) |
| `npm run --silent mcp` | Kept MCP server over stdio (needs `KEPT_PARTY_TOKEN`) |
| `npm run party-token -- <party_id>` | Print the bearer token for a party |
| `npm run demo:verify -- --runs 3` | Run the 2-of-3 verifier quorum against the three demo sites and check each result (no keys needed) |

## License

MIT. See [LICENSE](LICENSE).
