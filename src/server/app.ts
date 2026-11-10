import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import type { Config } from "../config.js";
import { getReceipt, ReceiptUnavailableError } from "../core/receipt-store.js";
import { JobNotFoundError } from "../core/state.js";
import type { Db } from "../db/client.js";
import type { PaymentRail } from "../rails/types.js";
import type { VerificationSummary } from "../verifier/orchestrator.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "../mcp/server.js";
import { apiErrors, apiRouter } from "./api.js";
import { requireParty } from "./auth.js";
import { publicKeyring, type Keyring, type VerifierKey } from "../qaps/keys.js";
import type { EvidenceStore } from "../verifier/evidence-store.js";

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

export const DEMO_SITES_DIR = fileURLToPath(new URL("../../demo/sites/", import.meta.url));
export const REPORT_DIR = fileURLToPath(new URL("../../web/report/", import.meta.url));

/**
 * The report shows text that came from hostile deliverables. It is rendered
 * with textContent only, and this policy is the second fence: no inline script,
 * no third-party anything, images and fetches from this origin only.
 */
const REPORT_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export interface AppDeps {
  db?: Db;
  keyring?: Keyring;
  /** Kept's receipt-sealing key (ISSUER_ID). */
  issuer?: VerifierKey;
  /** PayPal rail for lock/confirm/settle (T2.3). */
  rail?: PaymentRail;
  /** Runs the verifier quorum for a job (see buildVerifier in server/verifier.ts). */
  verify?: (db: Db, jobId: string) => Promise<VerificationSummary>;
  evidence?: EvidenceStore;
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

  // Kept's receipt-sealing key, so receipt holders can check who sealed a receipt.
  app.get("/.well-known/kept/issuer.json", (_req, res) => {
    if (!deps.issuer) {
      res.status(503).json({ error: "issuer key not loaded" });
      return;
    }
    res.set("Cache-Control", "public, max-age=300").json({ protocol: "kept-qaps/1", issuer: deps.issuer.public });
  });

  // Evidence artifacts, addressed by their SHA-256 (the same hash the verifiers signed).
  app.get("/evidence/:file", (req, res) => {
    const m = req.params.file.match(/^([0-9a-f]{64})\.(png|json)$/);
    const data = m && deps.evidence?.get(m[1]!, m[2] as "png" | "json");
    if (!data) {
      res.status(404).json({ error: "no such artifact" });
      return;
    }
    res.set("Cache-Control", "public, max-age=31536000, immutable").type(m![2]!).send(data);
  });

  // Proof Receipt (section 6.12): everything needed to check a payout offline.
  // `?download=1` makes browsers save it as a file (the receipt page's download button links here).
  app.get("/jobs/:id/receipt", (req, res) => {
    if (!deps.db || !deps.issuer) {
      res.status(503).json({ error: "database or issuer key not available" });
      return;
    }
    try {
      const receipt = getReceipt(deps.db, req.params.id, { publicBaseUrl: config.app.publicBaseUrl, issuer: deps.issuer });
      if (req.query.download !== undefined) {
        const safeId = req.params.id.replace(/[^A-Za-z0-9_-]/g, "_");
        res.attachment(`kept-receipt-${safeId}.json`);
      }
      res.set("Cache-Control", "no-store").json(receipt);
    } catch (err) {
      if (err instanceof JobNotFoundError) res.status(404).json({ error: err.message });
      else if (err instanceof ReceiptUnavailableError) res.status(409).json({ error: err.message });
      else throw err;
    }
  });

  // Evidence report (T3.9): a page that renders the job's Proof Receipt.
  app.use("/assets/report", (_req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    next();
  }, express.static(REPORT_DIR, { index: false, maxAge: 0 }));
  app.get("/jobs/:id/report", (_req, res) => {
    res.set({ "Content-Security-Policy": REPORT_CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
    res.sendFile("index.html", { root: REPORT_DIR });
  });

  // The MCP server (T4.1): Streamable HTTP, stateless, one MCP server per request
  // bound to the party whose bearer token came with it.
  if (deps.db && deps.keyring) {
    const { db, keyring } = deps;
    app.post("/mcp", requireParty(db, config.app.mcpAuthToken), (req, res, next) => {
      const server = createMcpServer(config, { db, keyring, issuer: deps.issuer, rail: deps.rail, verify: deps.verify }, req.party!);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      server
        .connect(transport)
        .then(() => transport.handleRequest(req, res, req.body))
        .catch(next);
    });
    // Stateless: no server-initiated streams and no sessions to delete.
    app.all("/mcp", (_req, res) => {
      res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this MCP server is stateless, use POST." }, id: null });
    });
  }

  // The job lifecycle API (T2.6).
  if (deps.db && deps.keyring) {
    app.use(apiRouter(config, { db: deps.db, keyring: deps.keyring, rail: deps.rail, verify: deps.verify }));
  }

  // Demo deliverables (good / flawed / sneaky) and the tiny API their contact form posts to.
  app.use(
    "/demo/sites",
    express.static(DEMO_SITES_DIR, { index: "index.html", redirect: true, etag: false, lastModified: false, maxAge: 0 }),
  );
  app.post("/demo/api/contact", (req, res) => {
    const { name, email, message } = (req.body ?? {}) as Record<string, unknown>;
    if (![name, email, message].every((v) => typeof v === "string" && v.trim() && v.length < 5000)) {
      res.status(400).json({ ok: false, error: "name, email and message are required" });
      return;
    }
    res.json({ ok: true });
  });

  app.get("/", (_req, res) => {
    res.type("html").send(PLACEHOLDER_PAGE);
  });

  app.use(apiErrors);

  return app;
}
