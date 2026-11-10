import express, { type Express } from "express";
import type { Config } from "../config.js";
import { publicKeyring, type Keyring } from "../qaps/keys.js";

const PLACEHOLDER_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kept</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; color: #1f2933; }
  h1 { margin-bottom: 0.25rem; }
  p.tag { color: #52606d; margin-top: 0; }
</style>
</head>
<body>
  <h1>Kept</h1>
  <p class="tag">Money that checks the work before it moves.</p>
  <p>The web UI is not built yet. The server is running: <a href="/health">/health</a></p>
</body>
</html>`;

export interface AppDeps {
  keyring?: Keyring;
}

export function createApp(config: Config, deps: AppDeps = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "kept", rail: config.paypal.rail });
  });

  // Public verifier keys, so anyone can check attestations and Proof Receipts.
  app.get("/.well-known/kept/verifiers.json", (_req, res) => {
    if (!deps.keyring) {
      res.status(503).json({ error: "verifier keys not loaded" });
      return;
    }
    res.set("Cache-Control", "public, max-age=300").json(publicKeyring(deps.keyring));
  });

  app.get("/", (_req, res) => {
    res.type("html").send(PLACEHOLDER_PAGE);
  });

  return app;
}
