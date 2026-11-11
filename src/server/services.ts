import type { Config } from "../config.js";
import { openDb, type Db } from "../db/client.js";
import { loadKeyring, type Keyring, type VerifierKey } from "../qaps/keys.js";
import { verifierIds } from "../qaps/protocol.js";
import { ISSUER_ID } from "../qaps/receipt.js";
import type { PaymentRail } from "../rails/types.js";
import { EvidenceStore } from "../verifier/evidence-store.js";
import type { VerificationSummary } from "../verifier/orchestrator.js";
import { buildVerifier, llmFromConfig } from "./verifier.js";
import type { LlmClient } from "../llm/client.js";

/** Everything the REST API and the MCP server work on. */
export interface Services {
  db: Db;
  keyring: Keyring;
  issuer: VerifierKey;
  evidence: EvidenceStore;
  /** The PayPal rail. Missing until T2.3: lock, confirm and settle then report that. */
  rail?: PaymentRail;
  verify: (db: Db, jobId: string) => Promise<VerificationSummary>;
  /** The language model (checklist drafts, AI judge). Missing without ANTHROPIC_API_KEY. */
  llm?: LlmClient;
}

/** Loads keys, opens the database and builds the verifier quorum from config. Throws ConfigError/KeyError. */
export function loadServices(config: Config): Services {
  const keys = { dir: config.verifier.keysDir, json: config.verifier.keysJson };
  const keyring = loadKeyring(verifierIds(config.verifier.quorumN), keys);
  const issuer = loadKeyring([ISSUER_ID], keys).get(ISSUER_ID)!;
  const db = openDb(config.app.databasePath);
  const evidence = new EvidenceStore(config.verifier.evidenceDir);
  const llm = llmFromConfig(config);
  return { db, keyring, issuer, evidence, llm, verify: buildVerifier(config, keyring, evidence, llm) };
}
