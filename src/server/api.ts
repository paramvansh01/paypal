import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { z } from "zod";
import type { Config } from "../config.js";
import {
  acceptChecklist,
  assertCanVerify,
  assertClient,
  assertParty,
  cancelJob,
  confirmFunds,
  createJob,
  disputeJob,
  resubmitWork,
  withdrawDispute,
  DecisionInput,
  jobEvents,
  jobView,
  ledger,
  listJobs,
  lockFunds,
  proposeChecklist,
  serverQuorum,
  submitWork,
} from "../core/jobs.js";
import { loadProofFromDb, recordClientDecision } from "../core/proof-store.js";
import { buildRailJob, settleJob } from "../core/settlement.js";
import { recordEvent } from "../core/state.js";
import type { Db } from "../db/client.js";
import { jobs, parties } from "../db/schema.js";
import type { Keyring } from "../qaps/keys.js";
import type { PaymentRail } from "../rails/types.js";
import type { VerificationSummary } from "../verifier/orchestrator.js";
import { requireParty } from "./auth.js";
import { classifyError, ServiceUnavailable } from "./errors.js";
import type { LlmClient } from "../llm/client.js";
import { DEFAULT_LLM_MODEL, generateChecklist } from "../llm/checklist-gen.js";
import { eq } from "drizzle-orm";

/**
 * T2.6: REST API for the whole job lifecycle. Reads are public (like the
 * Proof Receipt); every write needs a party token (src/server/auth.ts).
 *
 *   POST /jobs                              client posts a job (optional checklist)
 *   GET  /jobs?party=&status=&limit=        list
 *   GET  /jobs/:id                          full view (checklist, acceptances, verdicts, PayPal IDs, verification)
 *   PUT  /jobs/:id/checklist                either party proposes/replaces the checklist (no `quorum`: the server sets it)
 *   POST /jobs/:id/accept {checklist_hash}  either party accepts the hash it reviewed; both → AGREED (frozen)
 *   POST /jobs/:id/cancel                   client, before funds are held
 *   POST /jobs/:id/lock                     client: PayPal order + approval link
 *   POST /jobs/:id/confirm                  client, after approving in PayPal: capture/authorize → FUNDED
 *   POST /jobs/:id/submit {deliverable_url} worker → DELIVERED
 *   POST /jobs/:id/verify[?wait=1]          either party: runs the verifier quorum (202, or the summary with wait)
 *   POST /jobs/:id/items/:m/:i/decision     client decides an item the quorum left to a person
 *   POST /jobs/:id/settle                   either party: re-verifies, then releases/refunds on PayPal
 *   POST /jobs/:id/dispute {reason}         either party, VERIFIED → DISPUTED (settlement paused)
 *   POST /jobs/:id/dispute/withdraw         the party who disputed, DISPUTED → VERIFIED
 *   POST /jobs/:id/resubmit {deliverable_url}  worker, once, after a failed milestone: VERIFIED → DELIVERED
 *   GET  /jobs/:id/ledger                   money view
 *   GET  /jobs/:id/events                   the append-only event log (timeline)
 *   GET  /parties                           parties (ID, kind, name; no emails)
 *   GET  /me                                the party a token belongs to
 *   POST /checklists/generate               AI draft of a contract from {brief, budget_cents, currency} (needs an LLM key)
 */

export interface ApiDeps {
  db: Db;
  keyring: Keyring;
  /** The PayPal rail. Without it, lock/confirm/settle answer 503 (T2.3 builds it). */
  rail?: PaymentRail;
  /** Runs the verifier quorum for a job. Without it, verify answers 503. */
  verify?: (db: Db, jobId: string) => Promise<VerificationSummary>;
  /** Language model for checklist drafts. Without it, /checklists/generate answers 503. */
  llm?: LlmClient;
}

const asyncRoute =
  (fn: (req: Request, res: Response) => Promise<void> | void) =>
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res)).catch(next);
  };

const AcceptInput = z.strictObject({ checklist_hash: z.string().regex(/^[0-9a-f]{64}$/) });
const SubmitInput = z.strictObject({ deliverable_url: z.string().min(1).max(2000) });
const CancelInput = z.strictObject({ reason: z.string().max(500).optional() });
const ChecklistBody = z.strictObject({ checklist: z.unknown() });
const GenerateInput = z.strictObject({ brief: z.string().trim().min(1).max(5000), budget_cents: z.number().int().positive(), currency: z.string().regex(/^[A-Z]{3}$/).default("USD") });
const DisputeInput = z.strictObject({ reason: z.string().trim().min(1).max(2000) });
const ItemParams = z.object({ m: z.coerce.number().int().min(0), i: z.coerce.number().int().min(0) });

export function apiRouter(config: Config, deps: ApiDeps): Router {
  const { db } = deps;
  const r = express.Router();
  const auth = requireParty(db, config.app.mcpAuthToken);
  const quorum = () => serverQuorum(deps.keyring, config.verifier.quorumK);
  const needRail = (): PaymentRail => {
    if (!deps.rail) throw new ServiceUnavailable("No PayPal rail is configured on this server yet (task T2.3).");
    return deps.rail;
  };
  const id = (req: Request) => String(req.params.id);

  r.get("/jobs", (req, res) => {
    res.json({ jobs: listJobs(db, req.query as Record<string, string>) });
  });

  r.post("/jobs", auth, (req, res) => {
    const jobId = createJob(db, req.party!, req.body, { rail: config.paypal.rail, quorum: quorum() });
    res.status(201).location(`/jobs/${jobId}`).json(jobView(db, jobId));
  });

  r.get("/jobs/:id", (req, res) => {
    res.json(jobView(db, id(req)));
  });

  r.put("/jobs/:id/checklist", auth, (req, res) => {
    const { checklist } = ChecklistBody.parse(req.body);
    proposeChecklist(db, id(req), req.party!, checklist, quorum());
    res.json(jobView(db, id(req)));
  });

  r.post("/jobs/:id/accept", auth, (req, res) => {
    const { checklist_hash } = AcceptInput.parse(req.body);
    const result = acceptChecklist(db, id(req), req.party!, checklist_hash);
    res.json({ ...result, job: jobView(db, id(req)) });
  });

  r.post("/jobs/:id/cancel", auth, (req, res) => {
    const { reason } = CancelInput.parse(req.body ?? {});
    cancelJob(db, id(req), req.party!, reason);
    res.json(jobView(db, id(req)));
  });

  r.post(
    "/jobs/:id/lock",
    auth,
    asyncRoute(async (req, res) => {
      const rail = needRail();
      res.json(await lockFunds(db, id(req), req.party!, rail, buildRailJob));
    }),
  );

  r.post(
    "/jobs/:id/confirm",
    auth,
    asyncRoute(async (req, res) => {
      const rail = needRail();
      await confirmFunds(db, id(req), req.party!, rail, buildRailJob);
      res.json(jobView(db, id(req)));
    }),
  );

  r.post("/jobs/:id/submit", auth, (req, res) => {
    const { deliverable_url } = SubmitInput.parse(req.body);
    submitWork(db, id(req), req.party!, deliverable_url);
    res.json(jobView(db, id(req)));
  });

  r.post(
    "/jobs/:id/verify",
    auth,
    asyncRoute(async (req, res) => {
      if (!deps.verify) throw new ServiceUnavailable("Verification is not configured on this server.");
      const jobId = id(req);
      assertCanVerify(db, jobId, req.party!);
      recordEvent(db, jobId, "VERIFICATION_REQUESTED", { actor: req.party!.id });
      // verifyJob moves the job to VERIFYING before its first await, so a second request is refused.
      const run = deps.verify(db, jobId);
      if (req.query.wait !== undefined) {
        const summary = await run;
        res.json({ summary, job: jobView(db, jobId) });
        return;
      }
      const status = db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)).get()?.status;
      if (status !== "VERIFYING") {
        await run; // it failed before starting; surface that error
        return;
      }
      run.catch((err: unknown) => {
        recordEvent(db, jobId, "VERIFICATION_ERROR", { actor: "kept", payload: { error: err instanceof Error ? err.message : String(err) } });
      });
      res.status(202).location(`/jobs/${jobId}`).json({ status: "VERIFYING", job: `/jobs/${jobId}` });
    }),
  );

  r.post("/jobs/:id/items/:m/:i/decision", auth, (req, res) => {
    const jobId = id(req);
    assertClient(db, jobId, req.party!, "decide items");
    const { m, i } = ItemParams.parse(req.params);
    const { decision, note } = DecisionInput.parse(req.body);
    recordClientDecision(db, { jobId, m, i, decision, actor: req.party!.id, note });
    res.json(jobView(db, jobId));
  });

  r.post(
    "/jobs/:id/settle",
    auth,
    asyncRoute(async (req, res) => {
      const jobId = id(req);
      assertParty(db, jobId, req.party!, "settle it");
      const rail = needRail();
      const report = await settleJob(db, jobId, { rail, loadProof: loadProofFromDb, actor: req.party!.id });
      res.json({ settlement: report, job: jobView(db, jobId) });
    }),
  );

  r.post("/jobs/:id/dispute", auth, (req, res) => {
    const { reason } = DisputeInput.parse(req.body);
    disputeJob(db, id(req), req.party!, reason);
    res.json(jobView(db, id(req)));
  });

  r.post("/jobs/:id/dispute/withdraw", auth, (req, res) => {
    withdrawDispute(db, id(req), req.party!);
    res.json(jobView(db, id(req)));
  });

  r.post("/jobs/:id/resubmit", auth, (req, res) => {
    const { deliverable_url } = SubmitInput.parse(req.body);
    resubmitWork(db, id(req), req.party!, deliverable_url);
    res.json(jobView(db, id(req)));
  });

  r.get("/jobs/:id/ledger", (req, res) => {
    res.json(ledger(db, id(req)));
  });

  r.get("/jobs/:id/events", (req, res) => {
    res.json({ events: jobEvents(db, id(req)) });
  });

  r.get("/parties", (_req, res) => {
    res.json({ parties: db.select({ id: parties.id, kind: parties.kind, display_name: parties.displayName }).from(parties).orderBy(parties.id).all() });
  });

  r.post(
    "/checklists/generate",
    auth,
    asyncRoute(async (req, res) => {
      if (!deps.llm) throw new ServiceUnavailable("No language model is configured on this server (set ANTHROPIC_API_KEY).");
      const input = GenerateInput.parse(req.body);
      const checklist = await generateChecklist(deps.llm, config.llm.model ?? DEFAULT_LLM_MODEL, { brief: input.brief, budgetCents: input.budget_cents, currency: input.currency });
      res.json({ checklist, generated_by: config.llm.model ?? DEFAULT_LLM_MODEL, note: "An AI draft: both parties must review and accept it." });
    }),
  );

  r.get("/me", auth, (req, res) => {
    res.json({ party_id: req.party!.id, kind: req.party!.kind, display_name: req.party!.displayName });
  });

  r.use(apiErrors);
  return r;
}

export { ServiceUnavailable };

/** Maps domain errors to HTTP status codes with a message a person can act on. */
export function apiErrors(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) return next(err);
  const c = classifyError(err);
  if (!c) return next(err);
  const { status, ...body } = c;
  res.status(status).json(body);
}
