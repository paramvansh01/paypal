/**
 * npm run setup
 *
 * One-time local setup for people trying Kept: creates `.env` from
 * `.env.example` with a fresh random MCP_AUTH_TOKEN and judge mode on, so the
 * web app, MCP server and demo work with no other keys. Never overwrites an
 * existing `.env`. Then seeds the demo parties.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

if (existsSync(".env")) {
  console.log(".env already exists; leaving it as it is.");
} else {
  const set = (text: string, key: string, value: string) =>
    new RegExp(`^${key}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`) : `${text}\n${key}=${value}\n`;
  let env = readFileSync(".env.example", "utf8");
  env = set(env, "MCP_AUTH_TOKEN", randomBytes(32).toString("hex"));
  env = set(env, "DEMO_MODE", "1");
  env = set(env, "VERIFIER_BROWSER", "local");
  env = set(env, "DEMO_CLIENT_EMAIL", "client@example.com");
  env = set(env, "DEMO_WORKER_EMAIL", "worker@example.com");
  writeFileSync(".env", env, { mode: 0o600 });
  console.log("Created .env: a random MCP_AUTH_TOKEN, DEMO_MODE=1 (judge mode), local verifier browsers.");
  console.log("PayPal, Anthropic and KERNEL keys are optional: add them to .env when you have them (see the comments in it).");
}
