import { ConfigError, loadConfig } from "../src/config.js";
import { openDb } from "../src/db/client.js";
import { parties } from "../src/db/schema.js";
import { seedDemoParties } from "../src/db/seed.js";

try {
  const config = loadConfig();
  const db = openDb(config.app.databasePath);
  seedDemoParties(db, config);
  const all = db.select().from(parties).all();
  console.log(`Seeded ${config.app.databasePath}. Parties: ${all.length}`);
  for (const p of all) console.log(`  ${p.id}  ${p.kind}  ${p.displayName}  ${p.paypalEmail ?? "-"}`);
  db.$client.close();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
