import { readFileSync } from "node:fs";
import express, { type Router } from "express";
import { z } from "zod";
import { runBuyer } from "../../agents/buyer.js";
import { connectAgent } from "../../agents/kept-agent.js";
import { DEMO_SITES, runWorker } from "../../agents/worker.js";
import type { Config } from "../config.js";
import { DEMO_CLIENT_ID, DEMO_WORKER_ID } from "../db/seed.js";
import { getParty } from "../core/jobs.js";
import type { Db } from "../db/client.js";
import { partyToken } from "./auth.js";
import { buildRailJob } from "../core/settlement.js";
import type { PaymentRail } from "../rails/types.js";

/**
 * Demo helpers for the web UI.
 *
 *   GET  /demo/contract.json            the fixed 4 × $25 demo contract (prefills the "new job" form)
 *
 * Judge mode only (DEMO_MODE=1, T7.3):
 *   POST /demo/session {role}           a token for the demo client or demo worker, so a visitor can click through
 *   POST /demo/run {site}               the buyer and worker agents run a whole job over this server's own /mcp
 *   GET  /demo/runs/:jobId              where that run is (and the PayPal approval link while it waits)
 *   POST /demo/runs/:jobId/approved     the visitor approved the payment in PayPal; the buyer agent continues
 */

const CONTRACT = JSON.parse(readFileSync(new URL("../../demo/contract.json", import.meta.url), "utf8")) as { total_cents: number };

interface DemoRun {
  site: string;
  stage: "running" | "awaiting_approval" | "done" | "error";
  jobId?: string;
  approveUrl?: string;
  approved?: () => void;
  log: string[];
  error?: string;
}

export function demoRouter(config: Config, db: Db, rail?: PaymentRail): Router {
  const r = express.Router();
  const runs = new Map<string, DemoRun>();

  r.get("/demo/contract.json", (_req, res) => {
    res.json(CONTRACT);
  });

  const enabled: express.RequestHandler = (_req, res, next) => {
    if (!config.app.demoMode || !config.app.mcpAuthToken) {
      res.status(404).json({ error: "Judge mode is off on this server (DEMO_MODE=1 and MCP_AUTH_TOKEN turn it on)." });
      return;
    }
    next();
  };

  r.post("/demo/session", enabled, (req, res) => {
    const { role } = z.strictObject({ role: z.enum(["client", "worker"]) }).parse(req.body);
    const id = role === "client" ? DEMO_CLIENT_ID : DEMO_WORKER_ID;
    const party = getParty(db, id);
    if (!party) {
      res.status(409).json({ error: "The demo parties do not exist yet: run `npm run seed`." });
      return;
    }
    res.json({ token: partyToken(config.app.mcpAuthToken!, id), party_id: id, display_name: party.displayName });
  });

  r.post("/demo/run", enabled, async (req, res, next) => {
    try {
      const { site } = z.strictObject({ site: z.enum(DEMO_SITES) }).parse(req.body ?? {});
      if ([...runs.values()].filter((x) => x.stage === "running" || x.stage === "awaiting_approval").length >= 2) {
        res.status(429).json({ error: "Two demo runs are already in progress; try again in a minute." });
        return;
      }
      const self = `http://127.0.0.1:${config.app.port}`;
      const secret = config.app.mcpAuthToken!;
      const buyer = await connectAgent(self, partyToken(secret, DEMO_CLIENT_ID), "buyer");
      const worker = await connectAgent(self, partyToken(secret, DEMO_WORKER_ID), "worker");
      const run: DemoRun = { site, stage: "running", log: [] };
      const stop = new AbortController();
      const say = (who: string) => (line: string) => void run.log.push(`${who}: ${line}`);
      const workerRun = runWorker(worker, { deliverableBase: config.app.publicBaseUrl, site, signal: stop.signal, pollMs: 500, log: say("worker") });
      let respond: ((jobId: string) => void) | undefined = (jobId) => {
        runs.set(jobId, run);
        res.status(202).json({ job_id: jobId, job: `/app/jobs/${jobId}` });
      };
      runBuyer(buyer, {
        goal: "Halcyon Crumb bakery website: home page, menu, a working contact form, mobile friendly and fast",
        title: `Halcyon Crumb website (${site} delivery)`,
        budgetCents: CONTRACT.total_cents,
        workerId: DEMO_WORKER_ID,
        checklist: CONTRACT,
        pollMs: 500,
        log: say("buyer"),
        onPosted: (jobId) => {
          run.jobId = jobId;
          respond?.(jobId);
          respond = undefined;
        },
        onApproval: (url) => {
          if (url.startsWith("about:blank")) return Promise.resolve(); // the OFFLINE stand-in needs no approval
          run.stage = "awaiting_approval";
          run.approveUrl = url;
          return new Promise<void>((resolve) => {
            let timer: ReturnType<typeof setInterval> | undefined;
            run.approved = () => {
              if (timer) clearInterval(timer);
              run.approved = undefined;
              run.stage = "running";
              resolve();
            };
            // Notice the approval on our own: PayPal marks the order APPROVED once the buyer approves it.
            if (rail && run.jobId) {
              const jobId = run.jobId;
              timer = setInterval(() => {
                rail.status(buildRailJob(db, jobId))
                  .then((s) => { if (s.orderStatus === "APPROVED") run.approved?.(); })
                  .catch(() => { /* keep waiting; the button still works */ });
              }, 3000);
            }
          });
        },
      })
        .then(() => {
          run.stage = "done";
        })
        .catch((err: unknown) => {
          run.stage = "error";
          run.error = err instanceof Error ? err.message : String(err);
          if (respond) res.status(500).json({ error: run.error });
        })
        .finally(async () => {
          stop.abort();
          await workerRun.catch(() => {});
          await buyer.close();
          await worker.close();
        });
    } catch (err) {
      next(err);
    }
  });

  r.get("/demo/runs/:jobId", enabled, (req, res) => {
    const run = runs.get(req.params.jobId as string);
    if (!run) {
      res.json({ stage: null }); // most jobs are not demo runs; not an error
      return;
    }
    res.json({ site: run.site, stage: run.stage, approve_url: run.approveUrl ?? null, error: run.error ?? null, log: run.log });
  });

  r.post("/demo/runs/:jobId/approved", enabled, (req, res) => {
    const run = runs.get(req.params.jobId as string);
    if (!run?.approved || run.stage !== "awaiting_approval") {
      res.status(409).json({ error: "this run is not waiting for a PayPal approval" });
      return;
    }
    run.approved();
    res.json({ ok: true });
  });

  return r;
}
