import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson, checklistHash, contractItems, parseChecklist, type Checklist, type QuorumPolicy } from "../core/checklist.js";
import { SignedAttestation, verifyAttestation } from "./attestation.js";
import { fingerprintOf, type VerifierPublicKey } from "./keys.js";
import { evidenceRoot, LeafRecord, type Vote } from "./leaf.js";
import { HEX64, PROTOCOL } from "./protocol.js";

/**
 * QAPS part 2: the k-of-n quorum rule and the quorum certificate (section 6.9).
 * Everything here is pure: same inputs, same answer, no I/O.
 */

export const FINAL_VERDICTS = ["pass", "fail", "needs_client"] as const;
export type FinalVerdict = (typeof FINAL_VERDICTS)[number];
export const REASONS = ["quorum", "no_quorum", "injection", "client"] as const;
export type Reason = (typeof REASONS)[number];

export interface Ballot {
  verdict: Vote;
  injection: boolean;
}

export interface ItemDecision {
  verdict: FinalVerdict;
  reason: Reason;
}

/**
 * The quorum rule for one item.
 * 1. client_approval → needs_client (only the client decides).
 * 2. ≥ k injection flags → fail (reason: injection).
 * 3. An injection flag otherwise counts as a fail vote. ≥ k clean pass votes →
 *    pass; ≥ k fail votes → fail (reason: quorum).
 * 4. Anything else → needs_client (no_quorum): a human decides.
 *
 * Why an injection flag is a vote and not a veto: votes only ever decrease
 * when reports are left out, and 2k > n, so a certificate built from any
 * subset of the reports can never flip pass↔fail — at worst an item goes to
 * the client. A veto would let whoever builds the certificate bypass it by
 * dropping the one report that raised it. Lone flags stay visible in the
 * evidence and the receipt.
 */
export function decideItem(checkType: string, ballots: readonly Ballot[], k: number): ItemDecision {
  if (checkType === "client_approval") return { verdict: "needs_client", reason: "client" };
  const injections = ballots.filter((b) => b.injection).length;
  if (injections >= k) return { verdict: "fail", reason: "injection" };
  const passVotes = ballots.filter((b) => b.verdict === "pass" && !b.injection).length;
  const failVotes = ballots.filter((b) => b.verdict === "fail" || b.injection).length;
  if (passVotes >= k) return { verdict: "pass", reason: "quorum" };
  if (failVotes >= k) return { verdict: "fail", reason: "quorum" };
  return { verdict: "needs_client", reason: "no_quorum" };
}

export const CertificateItem = z.strictObject({
  m: z.number().int().min(0),
  i: z.number().int().min(0),
  verdict: z.enum(FINAL_VERDICTS),
  reason: z.enum(REASONS),
});
export type CertificateItem = z.infer<typeof CertificateItem>;

export const QuorumCertificate = z.strictObject({
  v: z.literal(PROTOCOL),
  type: z.literal("quorum_certificate"),
  job_id: z.string().min(1).max(100),
  contract_hash: z.string().regex(HEX64),
  deliverable_url: z.url().max(2000),
  k: z.number().int().min(1),
  n: z.number().int().min(1),
  attestations: z.array(SignedAttestation).min(1).max(7),
  items: z.array(CertificateItem),
  issued_at: z.iso.datetime(),
});
export type QuorumCertificate = z.infer<typeof QuorumCertificate>;

/** One verifier's full output: its signed attestation plus the leaves it attests to. */
export interface VerifierReport {
  attestation: SignedAttestation;
  leaves: LeafRecord[];
}

export function trustedKeys(policy: QuorumPolicy): VerifierPublicKey[] {
  return policy.verifiers.map((v) => ({
    id: v.id,
    alg: "Ed25519",
    public_key: v.public_key,
    fingerprint: fingerprintOf(v.public_key),
  }));
}

export function certificateHash(cert: QuorumCertificate): string {
  return createHash("sha256").update(canonicalJson(cert), "utf8").digest("hex");
}

export type CheckResult<T> = { ok: true; value: T } | { ok: false; reason: string };
const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

interface Expected {
  job_id: string;
  contract_hash: string;
  deliverable_url: string;
}

/**
 * Checks one verifier report on its own: signature by a contract-listed key,
 * same job/contract/deliverable, one leaf per contract item in order with the
 * right check type, and the signed Merkle root and leaf count match the leaves.
 */
export function checkReport(report: VerifierReport, contract: Checklist, expected: Expected): CheckResult<VerifierReport> {
  const sig = verifyAttestation(report.attestation, trustedKeys(contract.quorum));
  if (!sig.ok) return fail(sig.reason);
  const p = report.attestation.payload;
  const who = p.verifier_id;
  if (p.job_id !== expected.job_id) return fail(`${who} attested a different job (${p.job_id})`);
  if (p.contract_hash !== expected.contract_hash) return fail(`${who} attested a different contract`);
  if (p.deliverable_url !== expected.deliverable_url) return fail(`${who} attested a different deliverable URL`);

  const items = contractItems(contract);
  if (!Array.isArray(report.leaves)) return fail(`${who}: leaves missing`);
  if (report.leaves.length !== items.length) {
    return fail(`${who}: ${report.leaves.length} leaves for ${items.length} contract items`);
  }
  if (p.leaf_count !== report.leaves.length) return fail(`${who}: signed leaf_count ${p.leaf_count} ≠ ${report.leaves.length} leaves`);
  for (const [idx, { m, i, item }] of items.entries()) {
    const parsed = LeafRecord.safeParse(report.leaves[idx]);
    if (!parsed.success) return fail(`${who}: leaf ${idx} is malformed`);
    const leaf = parsed.data;
    if (leaf.m !== m || leaf.i !== i) return fail(`${who}: leaf ${idx} is for item ${leaf.m}.${leaf.i}, expected ${m}.${i}`);
    if (leaf.check_type !== item.check_type) return fail(`${who}: leaf ${idx} has check type ${leaf.check_type}, contract says ${item.check_type}`);
  }
  if (evidenceRoot(report.leaves) !== p.merkle_root) return fail(`${who}: evidence does not match the signed Merkle root`);
  return { ok: true, value: report };
}

/** Applies the quorum rule to every contract item, using the given (already checked) reports. */
export function decideAll(contract: Checklist, reports: readonly VerifierReport[]): CertificateItem[] {
  return contractItems(contract).map(({ m, i, item }, idx) => {
    const ballots = reports.map((r) => {
      const leaf = r.leaves[idx]!;
      return { verdict: leaf.verdict, injection: leaf.injection };
    });
    return { m, i, ...decideItem(item.check_type, ballots, contract.quorum.k) };
  });
}

export interface BuildResult {
  certificate: QuorumCertificate;
  /** Reports left out of the certificate, with the reason (bad signature, wrong root, …). */
  rejected: { verifier_id: string; reason: string }[];
}

/**
 * Builds a certificate from whatever reports arrived. Reports that fail any
 * check are left out (and listed). Throws if fewer than k distinct verifiers remain.
 */
export function buildCertificate(args: {
  job_id: string;
  contract: unknown;
  deliverable_url: string;
  reports: readonly VerifierReport[];
  issued_at: string;
}): BuildResult {
  const contract = parseChecklist(args.contract);
  const expected = { job_id: args.job_id, contract_hash: checklistHash(contract), deliverable_url: args.deliverable_url };
  const accepted: VerifierReport[] = [];
  const rejected: BuildResult["rejected"] = [];
  for (const r of args.reports) {
    const id = String(r?.attestation?.payload?.verifier_id ?? "unknown");
    const res = checkReport(r, contract, expected);
    if (!res.ok) rejected.push({ verifier_id: id, reason: res.reason });
    else if (accepted.some((a) => a.attestation.payload.verifier_id === id)) {
      rejected.push({ verifier_id: id, reason: `duplicate report from ${id}` });
    } else accepted.push(r);
  }
  const { k, n } = contract.quorum;
  if (accepted.length < k) {
    throw new QuorumNotReachedError(accepted.length, k, rejected);
  }
  // Keep a stable order (contract's verifier order) so the certificate hash is deterministic.
  const order = contract.quorum.verifiers.map((v) => v.id);
  accepted.sort((a, b) => order.indexOf(a.attestation.payload.verifier_id) - order.indexOf(b.attestation.payload.verifier_id));
  const certificate: QuorumCertificate = {
    v: PROTOCOL,
    type: "quorum_certificate",
    ...expected,
    k,
    n,
    attestations: accepted.map((r) => r.attestation),
    items: decideAll(contract, accepted),
    issued_at: args.issued_at,
  };
  return { certificate: QuorumCertificate.parse(certificate), rejected };
}

export class QuorumNotReachedError extends Error {
  constructor(
    readonly valid: number,
    readonly k: number,
    readonly rejected: BuildResult["rejected"],
  ) {
    super(
      `Only ${valid} valid verifier report(s), ${k} needed.` +
        (rejected.length ? ` Rejected: ${rejected.map((r) => `${r.verifier_id} (${r.reason})`).join("; ")}` : ""),
    );
    this.name = "QuorumNotReachedError";
  }
}

/**
 * Full, from-scratch validation (what `settle` and the receipt verifier run).
 * Trust comes only from the contract (whose hash is on the PayPal order):
 * its k, n and verifier keys. Returns the item decisions if everything holds.
 */
export function validateCertificate(args: {
  certificate: unknown;
  contract: unknown;
  /** Leaves per verifier ID, as published in the Proof Receipt. */
  leaves: Readonly<Record<string, LeafRecord[]>>;
  expected: Expected;
}): CheckResult<CertificateItem[]> {
  const parsedCert = QuorumCertificate.safeParse(args.certificate);
  if (!parsedCert.success) return fail(`certificate is malformed: ${parsedCert.error.issues[0]?.path.join(".")}`);
  const cert = parsedCert.data;
  const parsedContract = parseChecklistSafe(args.contract);
  if (!parsedContract.ok) return parsedContract;
  const contract = parsedContract.value;

  const recomputed = checklistHash(contract);
  if (recomputed !== args.expected.contract_hash) return fail("contract does not match the agreed contract hash");
  if (cert.contract_hash !== recomputed) return fail("certificate is for a different contract");
  if (cert.job_id !== args.expected.job_id) return fail("certificate is for a different job");
  if (cert.deliverable_url !== args.expected.deliverable_url) return fail("certificate is for a different deliverable URL");
  if (cert.k !== contract.quorum.k || cert.n !== contract.quorum.n) {
    return fail(`certificate claims ${cert.k}-of-${cert.n}, contract requires ${contract.quorum.k}-of-${contract.quorum.n}`);
  }

  const seen = new Set<string>();
  const reports: VerifierReport[] = [];
  for (const att of cert.attestations) {
    const id = att.payload.verifier_id;
    if (seen.has(id)) return fail(`duplicate attestation from ${id}`);
    seen.add(id);
    const res = checkReport({ attestation: att, leaves: args.leaves[id] ?? [] }, contract, args.expected);
    if (!res.ok) return res;
    reports.push(res.value);
  }
  if (reports.length < contract.quorum.k) return fail(`only ${reports.length} attestations, ${contract.quorum.k} required`);

  const decided = decideAll(contract, reports);
  if (canonicalJson(decided) !== canonicalJson(cert.items)) {
    return fail("certificate verdicts do not follow from the attested evidence");
  }
  return { ok: true, value: decided };
}

function parseChecklistSafe(input: unknown): CheckResult<Checklist> {
  try {
    return { ok: true, value: parseChecklist(input) };
  } catch {
    return fail("contract is malformed");
  }
}

export type MilestoneOutcome = "passed" | "failed" | "pending";
export interface ClientDecision {
  m: number;
  i: number;
  decision: "approve" | "reject";
}

/**
 * Final outcome per milestone. needs_client items are resolved by the client's
 * decision; a milestone passes only if every item ends as pass, fails as soon
 * as any item ends as fail, and is pending while a decision is outstanding.
 */
export function milestoneOutcomes(
  contract: Checklist,
  items: readonly CertificateItem[],
  decisions: readonly ClientDecision[] = [],
): MilestoneOutcome[] {
  return contract.milestones.map((ms, m) => {
    let pending = false;
    for (let i = 0; i < ms.items.length; i++) {
      const item = items.find((x) => x.m === m && x.i === i);
      let verdict: FinalVerdict | undefined = item?.verdict;
      if (verdict === "needs_client") {
        const d = decisions.find((x) => x.m === m && x.i === i);
        verdict = d ? (d.decision === "approve" ? "pass" : "fail") : undefined;
      }
      if (verdict === "fail") return "failed";
      if (verdict !== "pass") pending = true;
    }
    return pending ? "pending" : "passed";
  });
}
