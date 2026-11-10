import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checklistHash, contractItems, parseChecklist, type ChecklistInput } from "../../src/core/checklist.js";
import { signAttestation } from "../../src/qaps/attestation.js";
import { loadKeyring, type Keyring, type VerifierKey } from "../../src/qaps/keys.js";
import { evidenceRoot, type LeafRecord, type Vote } from "../../src/qaps/leaf.js";
import { verifierIds } from "../../src/qaps/protocol.js";
import type { VerifierReport } from "../../src/qaps/quorum.js";
import type { PaymentRail, RailJob, RailMilestone } from "../../src/rails/types.js";

export const JOB = "job_42";
export const DELIVERABLE = "https://deliverable.example/site/";
export const ISSUED = "2026-11-10T12:00:00.000Z";

/** A 3-milestone, 4-item contract: http + text, a form, and a client-approval item. */
export function qapsFixture(jobId = JOB) {
  const ring: Keyring = loadKeyring(verifierIds(3), { dir: mkdtempSync(join(tmpdir(), "kept-fx-")) });
  const contractInput = (): ChecklistInput => ({
    version: 1,
    currency: "USD",
    total_cents: 9000,
    quorum: { n: 3, k: 2, verifiers: [...ring.values()].map((k) => ({ id: k.id, public_key: k.public.public_key })) },
    milestones: [
      {
        title: "Page live",
        amount_cents: 3000,
        items: [
          { description: "Loads", check_type: "http_status", params: {} },
          { description: "Has the name", check_type: "text_present", params: { text: "Acme" } },
        ],
      },
      {
        title: "Form works",
        amount_cents: 3000,
        items: [
          {
            description: "Form submits",
            check_type: "form_submits",
            params: { fields: { "#email": "a@b.co" }, success: { text: "Thanks" } },
          },
        ],
      },
      { title: "Design", amount_cents: 3000, items: [{ description: "Client likes it", check_type: "client_approval", params: {} }] },
    ],
  });
  const contract = parseChecklist(contractInput());
  const hash = checklistHash(contract);

  /** votes: one per contract item; [vote, true] marks an injection flag. */
  function report(key: VerifierKey, votes: (Vote | [Vote, true])[], over: { url?: string; job?: string } = {}): VerifierReport {
    const leaves: LeafRecord[] = contractItems(contract).map(({ m, i, item }, idx) => {
      const v = votes[idx]!;
      const [verdict, injection] = Array.isArray(v) ? v : [v, false];
      return {
        m,
        i,
        check_type: item.check_type,
        verdict,
        injection,
        measured_value: verdict === "pass" ? "ok" : null,
        summary: `${key.id} says ${verdict}`,
        artifacts: { screenshot_sha256: "0".repeat(63) + String(idx) },
      };
    });
    const attestation = signAttestation(
      {
        v: "kept-qaps/1",
        type: "attestation",
        job_id: over.job ?? jobId,
        contract_hash: hash,
        deliverable_url: over.url ?? DELIVERABLE,
        verifier_id: key.id,
        browser: "chromium-local",
        judge_model: "claude-opus-5-5",
        merkle_root: evidenceRoot(leaves),
        leaf_count: leaves.length,
        issued_at: ISSUED,
      },
      key,
    );
    return { attestation, leaves };
  }

  return {
    ring,
    contractInput,
    contract,
    hash,
    report,
    A: ring.get("verifier-a")!,
    B: ring.get("verifier-b")!,
    C: ring.get("verifier-c")!,
  };
}

export const FLAWED_VOTES: Vote[] = ["pass", "pass", "fail", "needs_client"];

export const leavesByVerifier = (reports: VerifierReport[]) =>
  Object.fromEntries(reports.map((r) => [r.attestation.payload.verifier_id, r.leaves]));

/**
 * In-memory rail that behaves like PayPal's idempotency: a repeated request ID
 * returns the first result and moves no money. `failOn` makes the Nth
 * money-moving call throw once (simulating a crash or network error).
 */
export class MockRail implements PaymentRail {
  readonly name = "auth_capture" as const;
  /** Every call, including repeats. */
  calls: { kind: string; milestoneId?: string; requestId: string; certificateHash?: string }[] = [];
  /** Money that actually moved (first call per request ID only). */
  moved: { kind: "release" | "refund" | "finalize"; milestoneId?: string; cents: number }[] = [];
  private results = new Map<string, string>();
  private count = 0;

  constructor(
    private readonly opts: { failOn?: number; withFinalize?: boolean; delayMs?: number } = {},
  ) {
    if (!opts.withFinalize) this.finalize = undefined;
  }

  private async move(kind: "release" | "refund" | "finalize", requestId: string, certificateHash: string, ms?: RailMilestone) {
    this.calls.push({ kind, milestoneId: ms?.id, requestId, certificateHash });
    if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
    this.count++;
    if (this.opts.failOn === this.count) throw new Error(`simulated PayPal outage on call ${this.count}`);
    const existing = this.results.get(requestId);
    if (existing) return { paypalId: existing };
    const id = `PP-${kind.toUpperCase()}-${this.results.size + 1}`;
    this.results.set(requestId, id);
    this.moved.push({ kind, milestoneId: ms?.id, cents: ms?.amountCents ?? 0 });
    return { paypalId: id };
  }

  async lock() {
    return { orderId: "ORDER-1", approveUrl: "https://sandbox.paypal.com/approve" };
  }
  async confirmLocked() {
    return { captureIds: [] };
  }
  releaseMilestone(_job: RailJob, ms: RailMilestone, ctx: { requestId: string; certificateHash: string }) {
    return this.move("release", ctx.requestId, ctx.certificateHash, ms);
  }
  refundMilestone(_job: RailJob, ms: RailMilestone, ctx: { requestId: string; certificateHash: string }) {
    return this.move("refund", ctx.requestId, ctx.certificateHash, ms);
  }
  finalize?: PaymentRail["finalize"] = (_job, ctx) => this.move("finalize", ctx.requestId, ctx.certificateHash);
  async status() {
    return { orderStatus: "COMPLETED", heldCents: 0, releasedCents: 0, refundedCents: 0 };
  }
}
