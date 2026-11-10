import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { agreeChecklist, saveChecklist } from "../core/checklist-store.js";
import type { ChecklistInput } from "../core/checklist.js";
import { transition } from "../core/state.js";
import type { Db } from "../db/client.js";
import { jobs } from "../db/schema.js";
import { DEMO_CLIENT_ID, DEMO_WORKER_ID } from "../db/seed.js";
import type { Keyring } from "../qaps/keys.js";

/** The fixed 4 × $25 demo contract (deterministic checks only). */
export function demoContract(keyring: Keyring, k = 2): ChecklistInput {
  const base = JSON.parse(readFileSync(new URL("../../demo/contract.json", import.meta.url), "utf8")) as Omit<ChecklistInput, "quorum">;
  const verifiers = [...keyring.values()].map((key) => ({ id: key.id, public_key: key.public.public_key }));
  return { ...base, quorum: { n: verifiers.length, k, verifiers } };
}

/**
 * Creates a demo job and walks it to DELIVERED with the given deliverable,
 * skipping PayPal (for tests and the offline demo). Returns the job ID.
 */
export function createDeliveredDemoJob(
  db: Db,
  opts: { keyring: Keyring; deliverableUrl: string; jobId?: string; title?: string; rail?: "auth_capture" | "delayed_disbursement" },
): string {
  const id = opts.jobId ?? `job_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  db.insert(jobs)
    .values({
      id,
      title: opts.title ?? "Halcyon Crumb bakery website",
      brief: "A small bakery website: home page, menu, a working contact form, mobile friendly and fast.",
      clientId: DEMO_CLIENT_ID,
      workerId: DEMO_WORKER_ID,
      totalAmountCents: 1,
      rail: opts.rail ?? "auth_capture",
    })
    .run();
  saveChecklist(db, id, demoContract(opts.keyring));
  transition(db, id, "CHECKLIST_PROPOSED", { actor: "kept" });
  agreeChecklist(db, id, "both");
  transition(db, id, "FUNDING_PENDING", { actor: DEMO_CLIENT_ID });
  transition(db, id, "FUNDED", { actor: "paypal" });
  db.update(jobs).set({ deliverableUrl: opts.deliverableUrl }).where(eq(jobs.id, id)).run();
  transition(db, id, "DELIVERED", { actor: DEMO_WORKER_ID, payload: { deliverable_url: opts.deliverableUrl } });
  return id;
}
