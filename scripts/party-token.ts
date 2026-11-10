import { ConfigError, loadConfig } from "../src/config.js";
import { openDb } from "../src/db/client.js";
import { parties } from "../src/db/schema.js";
import { partyToken } from "../src/server/auth.js";

/** npm run party-token -- [party_id]   Prints the API token for one party, or for every party. */
try {
  const config = loadConfig();
  if (!config.app.mcpAuthToken) {
    console.error("MCP_AUTH_TOKEN is not set in .env. Set it to a long random string first.");
    process.exit(1);
  }
  const db = openDb(config.app.databasePath);
  const wanted = process.argv[2];
  const rows = db.select().from(parties).all().filter((p) => !wanted || p.id === wanted);
  if (!rows.length) {
    console.error(wanted ? `No party ${wanted}. Run npm run seed first.` : "No parties. Run npm run seed first.");
    process.exit(1);
  }
  for (const p of rows) console.log(`${p.id}\t${partyToken(config.app.mcpAuthToken, p.id)}`);
  db.$client.close();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
