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
import type { LlmClient } from "../llm/client.js";
import { apiErrors, apiRouter } from "./api.js";
import { requireParty } from "./auth.js";
import { demoRouter } from "./demo.js";
import { paypalRouter } from "./paypal-routes.js";
import type { PayPalClient } from "../paypal/client.js";
import { isOfflineRail } from "../rails/offline.js";
import { publicKeyring, type Keyring, type VerifierKey } from "../qaps/keys.js";
import type { EvidenceStore } from "../verifier/evidence-store.js";


export const DEMO_SITES_DIR = fileURLToPath(new URL("../../demo/sites/", import.meta.url));
export const REPORT_DIR = fileURLToPath(new URL("../../web/report/", import.meta.url));
export const TOOLS_DIR = fileURLToPath(new URL("../../tools/", import.meta.url));
export const APP_DIR = fileURLToPath(new URL("../../web/app/", import.meta.url));

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
  /** Language model for checklist drafts (T3.2). */
  llm?: LlmClient;
  /** PayPal REST client (webhook verification). */
  paypal?: PayPalClient;
}

export function createApp(config: Config, deps: AppDeps = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "kept",
      rail: config.paypal.rail,
      /** Whether money really moves: the PayPal sandbox rail, the OFFLINE stand-in, or nothing yet. */
      money: deps.rail ? (isOfflineRail(deps.rail) ? "offline" : "paypal_sandbox") : "none",
      demo_mode: config.app.demoMode,
      /** Whether an AI model is configured (contract drafts, AI judge). */
      ai: !!deps.llm,
    });
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
  const page = (root: string): express.RequestHandler => (_req, res) => {
    res.set({ "Content-Security-Policy": REPORT_CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
    res.sendFile("index.html", { root });
  };
  app.get("/jobs/:id/report", page(REPORT_DIR));
  // The standalone receipt verifier, so the report page can run it with WebCrypto (TQ.12).
  app.get("/assets/verify-receipt.mjs", (_req, res) => {
    res.set({ "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache" }).type("text/javascript").sendFile("verify-receipt.mjs", { root: TOOLS_DIR });
  });

  // The web app (T5): job list, job detail with live verdicts and the money panel, new-job flow.
  // Same build-free approach and CSP as the report.
  app.use("/assets/app", (_req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    next();
  }, express.static(APP_DIR, { index: false, maxAge: 0 }));
  app.get(["/", "/app/new", "/app/jobs/:id"], page(APP_DIR));

  // The MCP server (T4.1): Streamable HTTP, stateless, one MCP server per request
  // bound to the party whose bearer token came with it.
  if (deps.db && deps.keyring) {
    const { db, keyring } = deps;
    app.post("/mcp", requireParty(db, config.app.mcpAuthToken), (req, res, next) => {
      const server = createMcpServer(config, { db, keyring, issuer: deps.issuer, rail: deps.rail, verify: deps.verify, llm: deps.llm }, req.party!);
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

  // Reading the truth back from PayPal (T2.7).
  if (deps.db) app.use(paypalRouter(config, { db: deps.db, rail: deps.rail, paypal: deps.paypal }));

  // Demo helpers and judge mode (src/server/demo.ts).
  if (deps.db) app.use(demoRouter(config, deps.db));

  // The job lifecycle API (T2.6).
  if (deps.db && deps.keyring) {
    app.use(apiRouter(config, { db: deps.db, keyring: deps.keyring, rail: deps.rail, verify: deps.verify, llm: deps.llm }));
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


  app.use(apiErrors);

  return app;
}
