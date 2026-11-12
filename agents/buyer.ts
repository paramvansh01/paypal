/**
 * T4.3: the demo buyer agent, an MCP client.
 *
 *   KEPT_PARTY_TOKEN=<client token> tsx agents/buyer.ts --base http://localhost:3000 \
 *     --goal "A website for my bakery" --budget 100 --worker party_demo_worker [--contract demo/contract.json]
 *
 * Given a goal and a budget it posts the job with a contract, accepts it,
 * locks the funds (a person approves once in PayPal), waits for the delivery,
 * runs the verifier quorum, settles and saves the Proof Receipt.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { arg, connectAgent, dollars, sleep, type KeptAgent, type Log, type ToolData } from "./kept-agent.js";

export interface BuyerOptions {
  goal: string;
  title?: string;
  budgetCents: number;
  workerId: string;
  /** The contract (without `quorum`). Its total must equal the budget. */
  checklist: ToolData;
  /** Called with PayPal's approval link; resolve once a person has approved. */
  onApproval: (approveUrl: string) => Promise<void>;
  /**
   * What to do with an item the quorum left to the client (needs_client).
   * Default: reject. An agent spending someone's money does not approve what it could not verify.
   */
  decide?: (item: ToolData, job: ToolData) => Promise<{ decision: "approve" | "reject"; note: string }>;
  /** Called as soon as the job exists. */
  onPosted?: (jobId: string) => void;
  pollMs?: number;
  /** Give up waiting for the worker after this long. */
  timeoutMs?: number;
  log?: Log;
}

export interface BuyerResult {
  jobId: string;
  job: ToolData;
  verification: ToolData;
  settlement: ToolData;
  receipt: ToolData;
}

async function waitFor(agent: KeptAgent, jobId: string, statuses: string[], opts: { pollMs: number; timeoutMs: number; what: string }): Promise<ToolData> {
  const until = Date.now() + opts.timeoutMs;
  for (;;) {
    const job = await agent.call("get_job", { job_id: jobId });
    if (statuses.includes(job.status)) return job;
    if (job.status === "CANCELLED") throw new Error(`job ${jobId} was cancelled`);
    if (Date.now() > until) throw new Error(`gave up waiting for ${opts.what} (job is ${job.status})`);
    await sleep(opts.pollMs);
  }
}

export async function runBuyer(agent: KeptAgent, opts: BuyerOptions): Promise<BuyerResult> {
  const log = opts.log ?? ((l: string) => console.log(`[buyer] ${l}`));
  const wait = { pollMs: opts.pollMs ?? 1000, timeoutMs: opts.timeoutMs ?? 10 * 60_000 };
  const decide = opts.decide ?? (async () => ({ decision: "reject" as const, note: "The verifiers did not agree, and this agent does not approve what it could not verify." }));

  log(`Goal: ${opts.goal}. Budget ${dollars(opts.budgetCents)}. Posting the job with a ${opts.checklist.milestones.length}-milestone contract.`);
  const posted = await agent.call("post_job", {
    title: opts.title ?? opts.goal.slice(0, 200),
    brief: opts.goal,
    worker_id: opts.workerId,
    budget_cents: opts.budgetCents,
    currency: opts.checklist.currency ?? "USD",
    checklist: opts.checklist,
  });
  const jobId = posted.id as string;
  opts.onPosted?.(jobId);
  log(`Job ${jobId} posted. Contract fingerprint (SHA-256): ${posted.checklist_hash}`);
  await agent.call("accept_checklist", { job_id: jobId, checklist_hash: posted.checklist_hash });
  log("Accepted the contract. Waiting for the worker to accept it too…");
  const agreed = await waitFor(agent, jobId, ["AGREED"], { ...wait, what: "the worker's acceptance" });
  log(`Contract frozen: ${agreed.checklist_hash}. This fingerprint goes onto the PayPal order.`);

  const lock = await agent.call("lock_funds", { job_id: jobId });
  log(`PayPal order ${lock.paypal_order_id} created.`);
  // PayPal answers ORDER_NOT_APPROVED if confirm runs before the person finished approving.
  // That changes nothing on either side, so wait for the approval again instead of failing.
  let funded: ToolData | undefined;
  for (let attempt = 1; !funded; attempt++) {
    await opts.onApproval(lock.approve_url as string);
    try {
      funded = await agent.call("confirm_funds", { job_id: jobId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= 5 || !/ORDER_NOT_APPROVED|PAYER_ACTION_REQUIRED/.test(msg)) throw err;
      log("PayPal says the payment is not approved yet. Approve it in PayPal, then come back.");
    }
  }
  const held = (funded.capture_ids as string[]).length ? `capture ${(funded.capture_ids as string[]).join(", ")}` : `PayPal authorization ${funded.authorization_id}`;
  log(`Funds held by PayPal (${held}). Waiting for the delivery…`);

  const delivered = await waitFor(agent, jobId, ["DELIVERED"], { ...wait, what: "the delivery" });
  log(`Delivered: ${delivered.deliverable_url}. Running the verifier quorum (3 verifiers, 2 must agree)…`);
  const verification = await agent.call("verify", { job_id: jobId });
  for (const v of verification.verifiers as ToolData[]) log(`  ${v.verifier_id} on ${v.browser}: ${v.status}${v.error ? ` (${v.error})` : ""}`);
  if (verification.status !== "verified") throw new Error(`verification incomplete: fewer than k verifiers finished (round ${verification.round})`);
  if ((verification.injection_attempts as unknown[]).length) log(`  Prompt-injection attempt caught on ${(verification.injection_attempts as unknown[]).length} item(s).`);
  log(`Quorum certificate ${verification.certificate_hash}. Milestones: ${(verification.milestone_outcomes as string[]).join(", ")}.`);

  let job = verification.job as ToolData;
  for (const ms of job.milestones as ToolData[]) {
    for (const item of ms.items as ToolData[]) {
      if (item.verdict === "needs_client" && !item.client_decision) {
        const d = await decide(item, job);
        log(`  Item "${item.description}" needs the client: ${d.decision} (${d.note})`);
        job = await agent.call("approve_item", { job_id: jobId, m: ms.m, i: item.i, decision: d.decision, note: d.note });
      }
    }
  }

  const settled = await agent.call("settle", { job_id: jobId });
  const s = settled.settlement as ToolData;
  log(`Settled: ${dollars(s.releasedCents)} released to the worker, ${dollars(s.refundedCents)} refunded.`);
  for (const ms of settled.job.milestones as ToolData[]) {
    log(`  ${ms.status === "released" ? "released" : "refunded"}  ${dollars(ms.amount_cents)}  ${ms.title}  (${ms.paypal.release_id ?? ms.paypal.refund_id ?? "-"})`);
  }
  const receipt = await agent.call("get_receipt", { job_id: jobId });
  return { jobId, job: settled.job, verification, settlement: s, receipt };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const base = arg("base", process.env.KEPT_URL ?? "http://localhost:3000")!;
  const token = arg("token", process.env.KEPT_PARTY_TOKEN);
  const goal = arg("goal", "A website for my bakery: home page, menu and a working contact form")!;
  const budget = Math.round(Number(arg("budget", "100")) * 100);
  const contractPath = arg("contract", "demo/contract.json")!;
  if (!token || !Number.isFinite(budget) || budget <= 0) {
    console.error("usage: KEPT_PARTY_TOKEN=<client token> tsx agents/buyer.ts --base <url> --goal <text> --budget <dollars> --worker <party_id> [--contract file.json]");
    process.exit(2);
  }
  const checklist = JSON.parse(readFileSync(contractPath, "utf8")) as ToolData;
  const agent = await connectAgent(base, token, "buyer");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const result = await runBuyer(agent, {
    goal,
    budgetCents: budget,
    workerId: arg("worker", "party_demo_worker")!,
    checklist,
    onApproval: async (url) => {
      await rl.question(`[buyer] A person must approve this payment once in PayPal:\n\n    ${url}\n\nApprove it with the sandbox buyer account, then press Enter here. `);
    },
  });
  rl.close();
  const file = `kept-receipt-${result.jobId}.json`;
  writeFileSync(file, JSON.stringify(result.receipt, null, 2));
  console.log(`[buyer] Proof Receipt saved to ${file}. Check it: node tools/verify-receipt.mjs ${file}`);
  console.log(`[buyer] Evidence report: ${new URL(`/jobs/${result.jobId}/report`, base).href}`);
  await agent.close();
}
