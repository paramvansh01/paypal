import { ConfigError, loadConfig } from "../config.js";
import { openDb } from "../db/client.js";
import { KeyError, loadKeyring } from "../qaps/keys.js";
import { verifierIds } from "../qaps/protocol.js";
import { ISSUER_ID } from "../qaps/receipt.js";
import { EvidenceStore } from "../verifier/evidence-store.js";
import { createApp } from "./app.js";

try {
  const config = loadConfig();
  const keyring = loadKeyring(verifierIds(config.verifier.quorumN), {
    dir: config.verifier.keysDir,
    json: config.verifier.keysJson,
  });
  const issuer = loadKeyring([ISSUER_ID], { dir: config.verifier.keysDir, json: config.verifier.keysJson }).get(ISSUER_ID)!;
  const db = openDb(config.app.databasePath);
  const app = createApp(config, { db, keyring, issuer, evidence: new EvidenceStore(config.verifier.evidenceDir) });
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
