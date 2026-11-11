/**
 * npm run keys:export
 *
 * Prints this machine's verifier and issuer private keys as one JSON object, the
 * format VERIFIER_KEYS_JSON expects, so a host without a persistent disk (Render)
 * keeps the same keys across deploys. The output is SECRET: paste it straight
 * into the host's secret settings, never into git or chat.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { loadKeyring } from "../src/qaps/keys.js";
import { verifierIds } from "../src/qaps/protocol.js";
import { ISSUER_ID } from "../src/qaps/receipt.js";

const config = loadConfig();
const ids = [...verifierIds(config.verifier.quorumN), ISSUER_ID];
loadKeyring(ids, { dir: config.verifier.keysDir }); // creates any that are missing
const out = Object.fromEntries(ids.map((id) => [id, JSON.parse(readFileSync(join(config.verifier.keysDir, `${id}.jwk.json`), "utf8")) as unknown]));
console.error(`# ${ids.length} keys from ${config.verifier.keysDir}. SECRET: paste into VERIFIER_KEYS_JSON on the host, nowhere else.`);
console.log(JSON.stringify(out));
