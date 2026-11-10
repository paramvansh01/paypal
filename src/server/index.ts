import { ConfigError, loadConfig } from "../config.js";
import { openDb } from "../db/client.js";
import { KeyError, loadKeyring } from "../qaps/keys.js";
import { verifierIds } from "../qaps/protocol.js";
import { EvidenceStore } from "../verifier/evidence-store.js";
import { createApp } from "./app.js";

try {
  const config = loadConfig();
  const keyring = loadKeyring(verifierIds(config.verifier.quorumN), {
    dir: config.verifier.keysDir,
    json: config.verifier.keysJson,
  });
  const db = openDb(config.app.databasePath);
  const app = createApp(config, { db, keyring, evidence: new EvidenceStore(config.verifier.evidenceDir) });
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
