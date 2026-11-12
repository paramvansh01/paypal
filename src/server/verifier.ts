import type { Config } from "../config.js";
import { llmFromEnv, type LlmClient } from "../llm/client.js";
import { makeJudge } from "../llm/judge.js";

/** The LLM client from config: LLM_REPLAY_DIR (recorded answers), else the Anthropic API when a key is set. */
export function llmFromConfig(config: Config): LlmClient | undefined {
  return llmFromEnv({ apiKey: config.llm.apiKey, geminiApiKey: config.llm.geminiApiKey, replayDir: process.env.LLM_REPLAY_DIR, recordDir: process.env.LLM_RECORD_DIR });
}
import type { Db } from "../db/client.js";
import type { Keyring } from "../qaps/keys.js";
import { panelBrowsers } from "../verifier/browser.js";
import type { EvidenceStore } from "../verifier/evidence-store.js";
import { verifyJob, type VerificationSummary } from "../verifier/orchestrator.js";

/**
 * The verifier quorum as configured for this server. The built-in demo sites
 * are served by this same server (often on localhost), so its own origins are
 * the only private addresses a verifier may open.
 */
export function buildVerifier(config: Config, keyring: Keyring, store: EvidenceStore, llm: LlmClient | undefined = llmFromConfig(config)): (db: Db, jobId: string) => Promise<VerificationSummary> {
  const port = config.app.port;
  const allowOrigins = [...new Set([new URL(config.app.publicBaseUrl).origin, `http://127.0.0.1:${port}`, `http://localhost:${port}`])];
  return (db, jobId) =>
    verifyJob(db, jobId, {
      keyring,
      store,
      network: { allowOrigins },
      panel: (ids, url) =>
        panelBrowsers(ids, { preferKernel: config.verifier.browser === "kernel", kernelApiKey: config.verifier.kernelApiKey, deliverableUrl: url }),
      judgeModels: config.verifier.judgeModels,
      checkTimeoutMs: config.verifier.checkTimeoutMs,
      judgeFor: llm ? (model) => makeJudge(llm, model) : undefined,
    });
}
