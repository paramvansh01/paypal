import { z } from "zod";
import { canonicalJson, checklistHash, parseChecklist, type Checklist } from "../core/checklist.js";
import { LeafRecord } from "./leaf.js";
import { HEX64, PROTOCOL } from "./protocol.js";
import {
  certificateHash,
  milestoneOutcomes,
  QuorumCertificate,
  validateCertificate,
  type CertificateItem,
  type ClientDecision,
} from "./quorum.js";

/**
 * QAPS parts 1 + 5: the Proof Receipt (section 6.12).
 *
 * One JSON document that carries everything needed to check a payout offline:
 * the contract and its hash, the quorum certificate, the exact leaves each
 * attesting verifier signed, an index of the artifacts those leaves commit to,
 * the client's decisions, the milestone outcomes with their PayPal IDs, and the
 * job's event timeline.
 *
 * Trust is anchored in the contract hash, which is also on the PayPal order
 * (`custom_id`). Everything else either recomputes from the contract or is
 * signed by a key the contract lists. The receipt itself is not signed: if any
 * checked byte changes, `verifyReceipt` says what broke.
 */

const hex64 = z.string().regex(HEX64);

export const ReceiptArtifact = z.strictObject({
  sha256: hex64,
  kind: z.enum(["png", "json"]),
  /** Where to fetch it. The bytes must hash to `sha256`. */
  url: z.string().max(2000),
});
export type ReceiptArtifact = z.infer<typeof ReceiptArtifact>;

export const ReceiptMilestone = z.strictObject({
  m: z.number().int().min(0),
  title: z.string(),
  amount_cents: z.number().int(),
  /** Follows from the certificate and the client's decisions; verifyReceipt recomputes it. */
  outcome: z.enum(["passed", "failed", "pending"]),
  /** Kept's local record of what happened to the money. */
  status: z.string(),
  paypal: z.strictObject({
    capture_id: z.string().nullable(),
    release_id: z.string().nullable(),
    refund_id: z.string().nullable(),
  }),
});
export type ReceiptMilestone = z.infer<typeof ReceiptMilestone>;

export const ReceiptDecision = z.strictObject({
  m: z.number().int().min(0),
  i: z.number().int().min(0),
  decision: z.enum(["approve", "reject"]),
  actor: z.string(),
  note: z.string().nullable(),
  decided_at: z.string(),
});

export const ReceiptEvent = z.strictObject({
  type: z.string(),
  actor: z.string(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  at: z.string(),
});

export const ProofReceipt = z.strictObject({
  v: z.literal(PROTOCOL),
  type: z.literal("proof_receipt"),
  job: z.strictObject({
    id: z.string().min(1),
    title: z.string(),
    status: z.string(),
    rail: z.string(),
    deliverable_url: z.string(),
  }),
  contract: z.unknown(),
  contract_hash: hex64,
  certificate: z.unknown(),
  certificate_hash: hex64,
  /** Leaves per attesting verifier ID, exactly as signed, in contract order. */
  leaves: z.record(z.string(), z.array(z.unknown())),
  artifacts: z.array(ReceiptArtifact),
  client_decisions: z.array(ReceiptDecision),
  milestones: z.array(ReceiptMilestone),
  paypal: z.strictObject({
    order_id: z.string().nullable(),
    /** The PayPal field that should carry contract_hash. Check it in PayPal's own records. */
    contract_hash_field: z.literal("purchase_units[].custom_id"),
  }),
  events: z.array(ReceiptEvent),
  issued_at: z.iso.datetime(),
});
export type ProofReceipt = z.infer<typeof ProofReceipt>;

export interface ReceiptInput {
  job: ProofReceipt["job"];
  contract: Checklist;
  certificate: QuorumCertificate;
  leaves: Record<string, LeafRecord[]>;
  clientDecisions: z.infer<typeof ReceiptDecision>[];
  milestones: { title: string; amount_cents: number; status: string; paypal: ReceiptMilestone["paypal"] }[];
  paypalOrderId: string | null;
  events: z.infer<typeof ReceiptEvent>[];
  /** Base for artifact URLs, e.g. "https://kept.example" → https://kept.example/evidence/<sha>.png */
  publicBaseUrl: string;
  issuedAt: string;
}

/** Artifact name in a leaf → file kind in the evidence store. */
export function artifactKind(name: string): "png" | "json" {
  return name.startsWith("screenshot") ? "png" : "json";
}

function artifactIndex(leaves: Record<string, readonly LeafRecord[]>, base: string): ReceiptArtifact[] {
  const seen = new Map<string, ReceiptArtifact>();
  const root = base.replace(/\/+$/, "");
  for (const id of Object.keys(leaves).sort()) {
    for (const leaf of leaves[id]!) {
      for (const [name, sha256] of Object.entries(leaf.artifacts)) {
        const kind = artifactKind(name);
        const key = `${sha256}.${kind}`;
        if (!seen.has(key)) seen.set(key, { sha256, kind, url: `${root}/evidence/${key}` });
      }
    }
  }
  return [...seen.values()].sort((a, b) => (a.sha256 + a.kind < b.sha256 + b.kind ? -1 : 1));
}

/** Assembles a receipt. Pure: the caller loads everything (see src/core/receipt-store.ts). */
export function assembleReceipt(input: ReceiptInput): ProofReceipt {
  const cert = QuorumCertificate.parse(input.certificate);
  const contract = parseChecklist(input.contract);
  const attesting = cert.attestations.map((a) => a.payload.verifier_id);
  const leaves: Record<string, LeafRecord[]> = {};
  for (const id of attesting) {
    const l = input.leaves[id];
    if (!l) throw new Error(`no leaves for attesting verifier ${id}`);
    leaves[id] = l;
  }
  const decisions: ClientDecision[] = input.clientDecisions.map(({ m, i, decision }) => ({ m, i, decision }));
  const outcomes = milestoneOutcomes(contract, cert.items, decisions);
  if (input.milestones.length !== contract.milestones.length) throw new Error("milestone rows do not match the contract");

  return ProofReceipt.parse({
    v: PROTOCOL,
    type: "proof_receipt",
    job: input.job,
    contract,
    contract_hash: checklistHash(contract),
    certificate: cert,
    certificate_hash: certificateHash(cert),
    leaves,
    artifacts: artifactIndex(leaves, input.publicBaseUrl),
    client_decisions: input.clientDecisions,
    milestones: input.milestones.map((ms, m) => ({ m, ...ms, outcome: outcomes[m]! })),
    paypal: { order_id: input.paypalOrderId, contract_hash_field: "purchase_units[].custom_id" },
    events: input.events,
    issued_at: input.issuedAt,
  });
}

export interface ReceiptCheck {
  check: string;
  ok: boolean;
  detail: string;
}
export interface ReceiptVerification {
  ok: boolean;
  checks: ReceiptCheck[];
}

/**
 * Re-checks a receipt from scratch: contract hash, quorum certificate (keys,
 * signatures, Merkle roots, quorum maths), certificate hash, artifact index,
 * client decisions and milestone outcomes. Never throws. Fetching artifacts and
 * comparing the contract hash with PayPal's order are online steps, left to the
 * receipt verifier tools (TQ.8).
 */
export function verifyReceipt(input: unknown): ReceiptVerification {
  const checks: ReceiptCheck[] = [];
  const add = (check: string, ok: boolean, detail: string) => checks.push({ check, ok, detail });
  const done = () => ({ ok: checks.every((c) => c.ok), checks });

  const parsed = ProofReceipt.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    add("format", false, `receipt is malformed at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? ""}`.trim());
    return done();
  }
  add("format", true, "receipt has the kept-qaps/1 proof_receipt shape");
  const r = parsed.data;

  let contract: Checklist;
  try {
    contract = parseChecklist(r.contract);
  } catch {
    add("contract", false, "contract is malformed");
    return done();
  }
  const recomputed = checklistHash(contract);
  add(
    "contract_hash",
    recomputed === r.contract_hash,
    recomputed === r.contract_hash ? `contract hashes to ${recomputed}` : `contract hashes to ${recomputed}, receipt says ${r.contract_hash}`,
  );

  // Leaves: parse strictly, and only for verifiers that attested (others cannot be checked).
  const leaves: Record<string, LeafRecord[]> = {};
  let leavesOk = true;
  for (const [id, list] of Object.entries(r.leaves)) {
    const out: LeafRecord[] = [];
    for (const [idx, l] of list.entries()) {
      const p = LeafRecord.safeParse(l);
      if (!p.success) {
        add("leaves", false, `${id}: leaf ${idx} is malformed`);
        leavesOk = false;
        break;
      }
      out.push(p.data);
    }
    leaves[id] = out;
  }
  if (!leavesOk) return done();

  const cert = validateCertificate({
    certificate: r.certificate,
    contract,
    leaves,
    expected: { job_id: r.job.id, contract_hash: r.contract_hash, deliverable_url: r.job.deliverable_url },
  });
  add("certificate", cert.ok, cert.ok ? "signatures, Merkle roots and quorum verdicts all check out" : cert.reason);
  if (!cert.ok) return done();
  const certificate = QuorumCertificate.parse(r.certificate);
  const items: CertificateItem[] = cert.value;

  const certHash = certificateHash(certificate);
  add(
    "certificate_hash",
    certHash === r.certificate_hash,
    certHash === r.certificate_hash ? `certificate hashes to ${certHash}` : `certificate hashes to ${certHash}, receipt says ${r.certificate_hash}`,
  );

  const attesting = new Set(certificate.attestations.map((a) => a.payload.verifier_id));
  const extra = Object.keys(r.leaves).filter((id) => !attesting.has(id));
  add("leaves", extra.length === 0, extra.length ? `leaves from verifiers that did not attest: ${extra.join(", ")}` : "leaves only from attesting verifiers");

  const expectedArtifacts = canonicalJson(artifactIndex(leaves, "").map(({ sha256, kind }) => ({ sha256, kind })));
  const listedArtifacts = canonicalJson(
    [...r.artifacts].sort((a, b) => (a.sha256 + a.kind < b.sha256 + b.kind ? -1 : 1)).map(({ sha256, kind }) => ({ sha256, kind })),
  );
  const urlsOk = r.artifacts.every((a) => a.url.endsWith(`/evidence/${a.sha256}.${a.kind}`));
  add(
    "artifacts",
    expectedArtifacts === listedArtifacts && urlsOk,
    expectedArtifacts !== listedArtifacts
      ? "artifact index does not match the hashes committed in the leaves"
      : urlsOk
        ? `${r.artifacts.length} artifacts, each addressed by its SHA-256`
        : "an artifact URL does not end in /evidence/<sha256>.<kind>",
  );

  // Client decisions: only on items the quorum left to a person, at most one each.
  const seen = new Set<string>();
  let decisionsOk = true;
  let decisionsDetail = `${r.client_decisions.length} client decision(s), each on an item left to the client`;
  for (const d of r.client_decisions) {
    const key = `${d.m}.${d.i}`;
    const item = items.find((x) => x.m === d.m && x.i === d.i);
    if (seen.has(key)) [decisionsOk, decisionsDetail] = [false, `two decisions for item ${key}`];
    else if (!item) [decisionsOk, decisionsDetail] = [false, `decision for unknown item ${key}`];
    else if (item.verdict !== "needs_client") [decisionsOk, decisionsDetail] = [false, `item ${key} was decided by the quorum (${item.verdict}), not the client`];
    seen.add(key);
  }
  add("client_decisions", decisionsOk, decisionsDetail);

  const outcomes = milestoneOutcomes(contract, items, r.client_decisions);
  let msOk = r.milestones.length === contract.milestones.length;
  let msDetail = msOk ? "every milestone outcome follows from the verdicts" : `${r.milestones.length} milestones, contract has ${contract.milestones.length}`;
  if (msOk) {
    for (const [m, ms] of r.milestones.entries()) {
      const c = contract.milestones[m]!;
      if (ms.m !== m || ms.title !== c.title || ms.amount_cents !== c.amount_cents) {
        [msOk, msDetail] = [false, `milestone ${m} does not match the contract`];
        break;
      }
      if (ms.outcome !== outcomes[m]) {
        [msOk, msDetail] = [false, `milestone ${m} says ${ms.outcome}, the verdicts say ${outcomes[m]}`];
        break;
      }
      if ((ms.status === "released" && ms.outcome !== "passed") || (ms.status === "refunded" && ms.outcome !== "failed")) {
        [msOk, msDetail] = [false, `milestone ${m} was ${ms.status} but its outcome is ${ms.outcome}`];
        break;
      }
    }
  }
  add("milestones", msOk, msDetail);

  return done();
}
