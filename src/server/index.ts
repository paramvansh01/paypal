import { ConfigError, loadConfig } from "../config.js";
import { openDb } from "../db/client.js";
import { KeyError, loadKeyring } from "../qaps/keys.js";
import { verifierIds } from "../qaps/protocol.js";
import { ISSUER_ID } from "../qaps/receipt.js";
import { EvidenceStore } from "../verifier/evidence-store.js";
import { recoverInterruptedVerifications } from "../verifier/orchestrator.js";
import { createApp } from "./app.js";
import { buildVerifier } from "./verifier.js";

try {
  const config = loadConfig();
  const keyring = loadKeyring(verifierIds(config.verifier.quorumN), {
    dir: config.verifier.keysDir,
    json: config.verifier.keysJson,
  });
  const issuer = loadKeyring([ISSUER_ID], { dir: config.verifier.keysDir, json: config.verifier.keysJson }).get(ISSUER_ID)!;
  const db = openDb(config.app.databasePath);
  const recovered = recoverInterruptedVerifications(db);
  if (recovered.length) console.log(`Returned ${recovered.length} interrupted verification(s) to DELIVERED: ${recovered.join(", ")}`);
  const evidence = new EvidenceStore(config.verifier.evidenceDir);
  // No PayPal rail yet (T2.3): lock, confirm and settle answer 503 until it exists.
  const app = createApp(config, { db, keyring, issuer, evidence, verify: buildVerifier(config, keyring, evidence) });
  app.listen(config.app.port, () => {
    console.log(`Kept listening on ${config.app.publicBaseUrl} (port ${config.app.port})`);
  });
} catch (err) {
  if (err instanceof ConfigError || err instanceof KeyError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
