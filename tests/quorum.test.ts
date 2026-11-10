import { describe, expect, it } from "vitest";
import { checklistHash } from "../src/core/checklist.js";
import { signAttestation } from "../src/qaps/attestation.js";
import { VerifierKey } from "../src/qaps/keys.js";
import { VOTES, type Vote } from "../src/qaps/leaf.js";
import {
  buildCertificate,
  certificateHash,
  decideItem,
  milestoneOutcomes,
  QuorumNotReachedError,
  validateCertificate,
  type Ballot,
  type ItemDecision,
  type QuorumCertificate,
  type VerifierReport,
} from "../src/qaps/quorum.js";
import { DELIVERABLE, FLAWED_VOTES, ISSUED, JOB, leavesByVerifier, qapsFixture } from "./helpers/qaps.js";

// ---------- the quorum rule ----------

const b = (verdict: Vote, injection = false): Ballot => ({ verdict, injection });
const ALL_BALLOTS: Ballot[] = VOTES.flatMap((v) => [b(v), b(v, true)]);

function* combos(n: number): Generator<Ballot[]> {
  if (n === 0) {
    yield [];
    return;
  }
  for (const head of ALL_BALLOTS) for (const rest of combos(n - 1)) yield [head, ...rest];
}

function* subsets<T>(xs: T[], minSize: number): Generator<T[]> {
  for (let mask = 0; mask < 1 << xs.length; mask++) {
    const s = xs.filter((_, i) => mask & (1 << i));
    if (s.length >= minSize) yield s;
  }
}

describe("decideItem", () => {
  const cases: [string, Ballot[], ItemDecision][] = [
    ["unanimous pass", [b("pass"), b("pass"), b("pass")], { verdict: "pass", reason: "quorum" }],
    ["2 of 3 pass", [b("pass"), b("fail"), b("pass")], { verdict: "pass", reason: "quorum" }],
    ["2 of 3 fail", [b("fail"), b("pass"), b("fail")], { verdict: "fail", reason: "quorum" }],
    ["one crashed, two pass", [b("error"), b("pass"), b("pass")], { verdict: "pass", reason: "quorum" }],
    ["split with an error", [b("pass"), b("fail"), b("error")], { verdict: "needs_client", reason: "no_quorum" }],
    ["judges unsure", [b("needs_client"), b("needs_client"), b("pass")], { verdict: "needs_client", reason: "no_quorum" }],
    ["two catch an injection", [b("fail", true), b("fail", true), b("pass")], { verdict: "fail", reason: "injection" }],
    ["one injection flag is outvoted", [b("fail", true), b("pass"), b("pass")], { verdict: "pass", reason: "quorum" }],
    ["one injection flag counts as a fail vote", [b("pass", true), b("fail"), b("pass")], { verdict: "fail", reason: "quorum" }],
    ["flag + error + pass", [b("fail", true), b("error"), b("pass")], { verdict: "needs_client", reason: "no_quorum" }],
  ];
  it.each(cases)("%s", (_name, ballots, expected) => {
    expect(decideItem("text_present", ballots, 2)).toEqual(expected);
  });

  it("never auto-decides a client_approval item", () => {
    expect(decideItem("client_approval", [b("pass"), b("pass"), b("pass")], 2)).toEqual({ verdict: "needs_client", reason: "client" });
  });

  it.each([
    [3, 2],
    [5, 3],
  ])("n=%i, k=%i: every outcome is justified by k matching ballots", (n, k) => {
    for (const ballots of combos(n)) {
      const d = decideItem("text_present", ballots, k);
      const inj = ballots.filter((x) => x.injection).length;
      if (d.reason === "injection") expect(inj).toBeGreaterThanOrEqual(k);
      if (d.verdict === "pass") {
        expect(inj).toBeLessThan(k);
        expect(ballots.filter((x) => x.verdict === "pass" && !x.injection).length).toBeGreaterThanOrEqual(k);
      }
      if (d.verdict === "fail" && d.reason === "quorum") {
        expect(ballots.filter((x) => x.verdict === "fail" || x.injection).length).toBeGreaterThanOrEqual(k);
      }
    }
  });

  it.each([
    [3, 2],
    [5, 3],
  ])("n=%i, k=%i: when the honest verifiers agree, the faulty ones can only force a human review", (n, k) => {
    const faulty = n - k;
    for (const honestVote of ["pass", "fail"] as const) {
      const honest = Array.from({ length: k }, () => b(honestVote));
      for (const bad of combos(faulty)) {
        const d = decideItem("text_present", [...honest, ...bad], k);
        expect([honestVote, "needs_client"]).toContain(d.verdict);
      }
    }
  });

  it.each([
    [3, 2],
    [5, 3],
  ])("n=%i, k=%i: leaving reports out can never flip pass and fail, only send an item to the client", (n, k) => {
    for (const all of combos(n)) {
      const full = decideItem("text_present", all, k);
      for (const subset of subsets(all, k)) {
        const partial = decideItem("text_present", subset, k);
        if (partial.verdict !== "needs_client") expect(partial.verdict).toBe(full.verdict);
      }
    }
  });
});

// ---------- certificates ----------

const fx = qapsFixture();
const { contractInput, contract, report, A, B, C } = fx;
const HASH = fx.hash;
const JOB_ = JOB;
const URL_ = DELIVERABLE;
const expected = { job_id: JOB_, contract_hash: HASH, deliverable_url: URL_ };
const FLAWED = FLAWED_VOTES;

function build(reports: VerifierReport[]) {
  return buildCertificate({ job_id: JOB_, contract: contractInput(), deliverable_url: URL_, reports, issued_at: ISSUED });
}
const leavesOf = leavesByVerifier;
const validate = (certificate: unknown, reports: VerifierReport[], over: Partial<typeof expected> = {}, c: unknown = contractInput()) =>
  validateCertificate({ certificate, contract: c, leaves: leavesOf(reports), expected: { ...expected, ...over } });

describe("buildCertificate + validateCertificate", () => {
  const reports = [report(A, FLAWED), report(B, FLAWED), report(C, ["pass", "fail", "fail", "needs_client"])];

  it("builds a valid certificate from three honest reports", () => {
    const { certificate, rejected } = build(reports);
    expect(rejected).toEqual([]);
    expect(certificate.items).toEqual([
      { m: 0, i: 0, verdict: "pass", reason: "quorum" },
      { m: 0, i: 1, verdict: "pass", reason: "quorum" },
      { m: 1, i: 0, verdict: "fail", reason: "quorum" },
      { m: 2, i: 0, verdict: "needs_client", reason: "client" },
    ]);
    expect(validate(certificate, reports)).toEqual({ ok: true, value: certificate.items });
  });

  it("is deterministic: report order does not change the certificate hash", () => {
    const h1 = certificateHash(build(reports).certificate);
    const h2 = certificateHash(build([...reports].reverse()).certificate);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("still settles when one verifier crashed (2 of 3)", () => {
    const { certificate } = build(reports.slice(0, 2));
    expect(certificate.attestations).toHaveLength(2);
    expect(validate(certificate, reports.slice(0, 2)).ok).toBe(true);
  });

  it("refuses to build below k valid reports", () => {
    expect(() => build(reports.slice(0, 1))).toThrow(QuorumNotReachedError);
  });

  it("leaves out a report signed by a key the contract does not list", () => {
    const outsider = VerifierKey.generate("verifier-c");
    const { certificate, rejected } = build([reports[0]!, reports[1]!, report(outsider, ["fail", "fail", "fail", "fail"])]);
    expect(rejected).toEqual([{ verifier_id: "verifier-c", reason: "key fingerprint does not match the published key for verifier-c" }]);
    expect(certificate.attestations).toHaveLength(2);
  });

  it("leaves out duplicates and reports edited after signing", () => {
    const edited = report(C, FLAWED);
    edited.leaves[2] = { ...edited.leaves[2]!, verdict: "pass" };
    const { rejected } = build([reports[0]!, reports[0]!, reports[1]!, edited]);
    expect(rejected.map((r) => r.reason)).toEqual([
      "duplicate report from verifier-a",
      "verifier-c: evidence does not match the signed Merkle root",
    ]);
  });

  it("leaves out reports for another job or another deliverable", () => {
    const { rejected } = build([reports[0]!, reports[1]!, report(C, FLAWED, { url: "https://evil.example/" })]);
    expect(rejected[0]!.reason).toMatch(/different deliverable URL/);
    const { rejected: r2 } = build([reports[0]!, reports[1]!, report(C, FLAWED, { job: "job_other" })]);
    expect(r2[0]!.reason).toMatch(/different job/);
  });

  it("fails the item when two verifiers catch an injection", () => {
    const sneaky: (Vote | [Vote, true])[] = ["pass", "pass", ["fail", true], "needs_client"];
    const { certificate } = build([report(A, sneaky), report(B, sneaky), report(C, ["pass", "pass", "pass", "needs_client"])]);
    expect(certificate.items[2]).toEqual({ m: 1, i: 0, verdict: "fail", reason: "injection" });
  });

  describe("tampering is caught by validateCertificate", () => {
    const { certificate } = build(reports);
    const clone = (): QuorumCertificate => structuredClone(certificate);

    const attacks: [string, () => ReturnType<typeof validate>, RegExp][] = [
      ["a forged verdict", () => {
        const c = clone();
        c.items[2]!.verdict = "pass";
        return validate(c, reports);
      }, /do not follow from the attested evidence/],
      ["a lowered threshold", () => {
        const c = clone();
        c.k = 1;
        return validate(c, reports);
      }, /claims 1-of-3, contract requires 2-of-3/],
      ["too few attestations", () => {
        const c = clone();
        c.attestations = c.attestations.slice(0, 1);
        return validate(c, reports);
      }, /only 1 attestations, 2 required/],
      ["a duplicated attestation", () => {
        const c = clone();
        c.attestations = [c.attestations[0]!, c.attestations[0]!];
        return validate(c, reports);
      }, /duplicate attestation from verifier-a/],
      ["a contract changed after agreement", () => {
        const changed = contractInput();
        changed.milestones[0]!.amount_cents = 2000;
        changed.milestones[1]!.amount_cents = 4000;
        return validate(certificate, reports, {}, changed);
      }, /does not match the agreed contract hash/],
      ["a swapped verifier key in the contract", () => {
        const changed = contractInput();
        changed.quorum.verifiers[2]!.public_key = VerifierKey.generate("x").public.public_key;
        return validate(certificate, reports, { contract_hash: checklistHash(changed) }, changed);
      }, /certificate is for a different contract/],
      ["another job", () => validate(certificate, reports, { job_id: "job_other" }), /different job/],
      ["another deliverable", () => validate(certificate, reports, { deliverable_url: "https://x.example/" }), /different deliverable/],
      ["edited evidence", () => {
        const r = structuredClone(reports);
        r[1]!.leaves[0]!.summary = "edited";
        return validate(certificate, r);
      }, /verifier-b: evidence does not match the signed Merkle root/],
      ["reordered evidence", () => {
        const r = structuredClone(reports);
        r[0]!.leaves.reverse();
        return validate(certificate, r);
      }, /verifier-a: leaf 0 is for item 2\.0, expected 0\.0/],
      ["missing evidence", () => validateCertificate({ certificate, contract: contractInput(), leaves: {}, expected }), /0 leaves for 4 contract items/],
      ["a re-signed attestation from an outsider", () => {
        const c = clone();
        const outsider = VerifierKey.generate("verifier-b");
        c.attestations[1] = signAttestation(c.attestations[1]!.payload, outsider);
        return validate(c, reports);
      }, /fingerprint does not match/],
      ["garbage", () => validate({ hello: "world" }, reports), /certificate is malformed/],
    ];
    it.each(attacks)("%s", (_name, attack, reason) => {
      const res = attack();
      expect(res.ok).toBe(false);
      expect(res.ok ? "" : res.reason).toMatch(reason);
    });
  });
});

describe("milestoneOutcomes", () => {
  const { certificate } = build([report(A, FLAWED), report(B, FLAWED)]);

  it("waits for the client on approval items, fails a failed milestone at once", () => {
    expect(milestoneOutcomes(contract, certificate.items)).toEqual(["passed", "failed", "pending"]);
  });

  it("applies the client's decisions", () => {
    expect(milestoneOutcomes(contract, certificate.items, [{ m: 2, i: 0, decision: "approve" }])).toEqual(["passed", "failed", "passed"]);
    expect(milestoneOutcomes(contract, certificate.items, [{ m: 2, i: 0, decision: "reject" }])).toEqual(["passed", "failed", "failed"]);
  });

  it("a client decision cannot override a quorum verdict", () => {
    expect(milestoneOutcomes(contract, certificate.items, [{ m: 1, i: 0, decision: "approve" }])[1]).toBe("failed");
  });
});
