import { requireConfig, type Config } from "../config.js";
import type { Db } from "./client.js";
import { parties } from "./schema.js";

export const DEMO_CLIENT_ID = "party_demo_client";
export const DEMO_WORKER_ID = "party_demo_worker";

/**
 * Creates or updates the two demo parties from env. Safe to run any number of
 * times: rows have fixed IDs and are upserted.
 */
export function seedDemoParties(db: Db, config: Config): { client: string; worker: string } {
  requireConfig(config, "demo");
  const rows = [
    {
      id: DEMO_CLIENT_ID,
      kind: "human" as const,
      displayName: "Demo client",
      paypalEmail: config.demo.clientEmail ?? null,
      paypalMerchantId: null,
    },
    {
      id: DEMO_WORKER_ID,
      kind: "agent" as const,
      displayName: "Demo worker agent",
      paypalEmail: config.demo.workerEmail ?? null,
      paypalMerchantId: config.demo.workerMerchantId ?? null,
    },
  ];
  db.transaction((tx) => {
    for (const row of rows) {
      const { id: _id, ...rest } = row;
      tx.insert(parties).values(row).onConflictDoUpdate({ target: parties.id, set: rest }).run();
    }
  });
  return { client: DEMO_CLIENT_ID, worker: DEMO_WORKER_ID };
}
