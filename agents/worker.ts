/**
 * T4.4: the demo worker agent, an MCP client.
 *
 *   KEPT_PARTY_TOKEN=<worker token> tsx agents/worker.ts --base http://localhost:3000 --site good|flawed|sneaky [--job <id>]
 *
 * It watches its jobs: accepts a proposed checklist after checking it is
 * well-formed and adds up, and delivers once the job is FUNDED. In demo mode
 * it submits one of the built-in demo sites, so every run is repeatable.
 */
import { pathToFileURL } from "node:url";
import { arg, connectAgent, dollars, sleep, type KeptAgent, type Log, type ToolData } from "./kept-agent.js";

export const DEMO_SITES = ["good", "flawed", "sneaky"] as const;
export type DemoSite = (typeof DEMO_SITES)[number];

export interface WorkerOptions {
  /** Where the deliverable is hosted (the built-in demo sites live on the Kept server). */
  deliverableBase: string;
  site: DemoSite;
  /** Only work on this job; stop once it is settled or cancelled. Without it, serve every job until aborted. */
  jobId?: string;
  pollMs?: number;
  signal?: AbortSignal;
  log?: Log;
}

/** What a worker checks before agreeing to a contract. */
export function reviewChecklist(job: ToolData): string | undefined {
  const c = job.checklist as { total_cents: number; currency: string; milestones: { amount_cents: number }[] } | null;
  if (!c) return "no checklist yet";
  const sum = c.milestones.reduce((s, m) => s + m.amount_cents, 0);
  if (sum !== c.total_cents || c.total_cents !== job.total_cents) return `amounts do not add up (${sum} vs ${c.total_cents} vs budget ${job.total_cents})`;
  if (c.currency !== job.currency) return "currency differs from the job";
  return undefined;
}

export async function runWorker(agent: KeptAgent, opts: WorkerOptions): Promise<void> {
  const log = opts.log ?? ((l: string) => console.log(`[worker] ${l}`));
  const pollMs = opts.pollMs ?? 1000;
  const done = new Set<string>();
  const handled = new Set<string>();
  while (!opts.signal?.aborted) {
    const ids: string[] = opts.jobId
      ? [opts.jobId]
      : ((await agent.call("list_jobs", { limit: 50 })).jobs as ToolData[]).filter((j) => j.worker_id === agent.partyId).map((j) => j.id as string);
    for (const id of ids) {
      if (done.has(id) || opts.signal?.aborted) continue;
      const job = await agent.call("get_job", { job_id: id });
      const key = `${id}:${job.status}:${job.checklist_hash}`;
      if (job.status === "CHECKLIST_PROPOSED" && !job.acceptances.worker && !handled.has(key)) {
        handled.add(key);
        const problem = reviewChecklist(job);
        if (problem) {
          log(`Not accepting "${job.title}": ${problem}.`);
          continue;
        }
        log(`Reviewed the contract for "${job.title}": ${job.checklist.milestones.length} milestones, ${dollars(job.total_cents)}. Accepting hash ${String(job.checklist_hash).slice(0, 12)}…`);
        const r = await agent.call("accept_checklist", { job_id: id, checklist_hash: job.checklist_hash });
        log(r.agreed ? "Both parties accepted: the contract is frozen." : "Accepted; waiting for the client.");
      } else if (job.status === "FUNDED" && !handled.has(key)) {
        handled.add(key);
        const url = new URL(`/demo/sites/${opts.site}/`, opts.deliverableBase).href;
        log(`The money is held. Delivering the ${opts.site} site: ${url}`);
        await agent.call("submit_work", { job_id: id, deliverable_url: url });
      } else if (["SETTLED", "CANCELLED", "AUTO_RELEASED"].includes(job.status)) {
        done.add(id);
        if (opts.jobId) return;
      }
    }
    await sleep(pollMs, opts.signal);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const base = arg("base", process.env.KEPT_URL ?? "http://localhost:3000")!;
  const token = arg("token", process.env.KEPT_PARTY_TOKEN);
  const site = arg("site", "good") as DemoSite;
  if (!token || !DEMO_SITES.includes(site)) {
    console.error("usage: KEPT_PARTY_TOKEN=<worker token> tsx agents/worker.ts --base <url> --site good|flawed|sneaky [--job <id>]");
    process.exit(2);
  }
  const agent = await connectAgent(base, token, "worker");
  console.log(`[worker] Connected to ${base} as ${agent.partyId}. Watching for jobs (Ctrl+C to stop).`);
  await runWorker(agent, { deliverableBase: base, site, jobId: arg("job") });
  await agent.close();
}
