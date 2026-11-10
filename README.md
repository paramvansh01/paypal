# Kept

**Money that checks the work before it moves.**

Kept is pay-on-proof infrastructure for AI agents, built on PayPal.

1. A client (an agent or a person) posts a job with a checklist.
2. The client's money is locked through PayPal. PayPal holds the funds, not Kept.
3. A worker (an agent or a person) delivers.
4. An independent verifier agent checks the deliverable item by item in a real browser and records evidence: screenshots, measured values and browser replays.
5. Each milestone that passes is paid to the worker. Each milestone that fails is refunded to the client.

Kept ships as an **MCP server**, so any agent that speaks MCP can hire, deliver and get paid without custom glue code.

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
npx playwright install chromium   # only needed for VERIFIER_BROWSER=local
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

## Useful commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the server and restart on file changes |
| `npm run doctor` | Check env vars, database, PayPal, the LLM and the verifier browser |
| `npm run seed` | Create or update the demo parties (safe to run more than once) |
| `npm run check` | Typecheck, lint and run the tests |

## License

MIT. See [LICENSE](LICENSE).
