import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadProofFromDb, recordClientDecision } from "../src/core/proof-store.js";
import { getReceipt, ReceiptUnavailableError } from "../src/core/receipt-store.js";
import { settleJob } from "../src/core/settlement.js";
import { openDb, type Db } from "../src/db/client.js";
import { seedDemoParties } from "../src/db/seed.js";
import { createDeliveredDemoJob } from "../src/demo/job.js";
import { loadKeyring } from "../src/qaps/keys.js";
import { verifierIds } from "../src/qaps/protocol.js";
import { buildCertificate, type VerifierReport } from "../src/qaps/quorum.js";
import { assembleReceipt, ISSUER_ID, sealReceipt, verifyReceipt, type ProofReceipt, type ReceiptInput } from "../src/qaps/receipt.js";
import { createApp } from "../src/server/app.js";
import { panelBrowsers } from "../src/verifier/browser.js";
import { EvidenceStore } from "../src/verifier/evidence-store.js";
import { verifyJob } from "../src/verifier/orchestrator.js";
import { DELIVERABLE, FLAWED_VOTES, ISSUED, JOB, leavesByVerifier, MockRail, qapsFixture } from "./helpers/qaps.js";

// ---------- pure: assemble + verify ----------

const fx = qapsFixture();
const issuer = loadKeyring([ISSUER_ID], { dir: mkdtempSync(join(tmpdir(), "kept-issuer-")) }).get(ISSUER_ID)!;

function input(reports: VerifierReport[], over: Partial<ReceiptInput> = {}): ReceiptInput {
  const { certificate } = buildCertificate({ job_id: JOB, contract: fx.contractInput(), deliverable_url: DELIVERABLE, reports, issued_at: ISSUED });
  return {
    job: { id: JOB, title: "Acme site", status: "VERIFIED", rail: "auth_capture", deliverable_url: DELIVERABLE },
    contract: fx.contract,
    certificate,
    leaves: leavesByVerifier(reports),
    clientDecisions: [{ m: 2, i: 0, decision: "approve", actor: "party_demo_client", note: null, decided_at: ISSUED }],
    milestones: fx.contract.milestones.map((m) => ({
      title: m.title,
      amount_cents: m.amount_cents,
      status: "pending",
      paypal: { capture_id: null, release_id: null, refund_id: null },
    })),
    paypalOrderId: "ORDER-1",
    events: [{ type: "VERIFIED", actor: "kept", payload: { certificate_hash: "x" }, at: ISSUED }],
    publicBaseUrl: "https://kept.example/",
    issuedAt: ISSUED,
    issuer,
    ...over,
  };
}

const flawed = () => [fx.report(fx.A, FLAWED_VOTES), fx.report(fx.B, FLAWED_VOTES), fx.report(fx.C, FLAWED_VOTES)];
const clone = (r: ProofReceipt): ProofReceipt => JSON.parse(JSON.stringify(r));
const failed = (r: unknown) => verifyReceipt(r).checks.filter((c) => !c.ok);

describe("Proof Receipt: assembly", () => {
  it("assembles a receipt that verifies from scratch", () => {
    const receipt = assembleReceipt(input(flawed()));
    expect(receipt).toMatchObject({ v: "kept-qaps/1", type: "proof_receipt", contract_hash: fx.hash });
    expect(receipt.milestones.map((m) => m.outcome)).toEqual(["passed", "failed", "passed"]);
    expect(Object.keys(receipt.leaves)).toEqual(["verifier-a", "verifier-b", "verifier-c"]);
    const v = verifyReceipt(receipt);
    expect(v.checks.filter((c) => !c.ok)).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.checks.map((c) => c.check)).toEqual([
      "format",
      "seal_sections",
      "seal_signature",
      "contract_hash",
      "certificate",
      "certificate_hash",
      "leaves",
      "artifacts",
      "client_decisions",
      "milestones",
    ]);
  });

  it("indexes every committed artifact once, addressed by its hash", () => {
    const receipt = assembleReceipt(input(flawed()));
    // The fixture gives each item one screenshot hash, shared across verifiers.
    expect(receipt.artifacts).toHaveLength(4);
    for (const a of receipt.artifacts) expect(a.url).toBe(`https://kept.example/evidence/${a.sha256}.png`);
  });

  it("includes only the verifiers in the certificate", () => {
    const [a, b] = flawed();
    const receipt = assembleReceipt(input([a!, b!]));
    expect(Object.keys(receipt.leaves)).toEqual(["verifier-a", "verifier-b"]);
    expect(verifyReceipt(receipt).ok).toBe(true);
  });

  it("a pending client decision leaves the milestone pending", () => {
    const receipt = assembleReceipt(input(flawed(), { clientDecisions: [] }));
    expect(receipt.milestones.map((m) => m.outcome)).toEqual(["passed", "failed", "pending"]);
    expect(verifyReceipt(receipt).ok).toBe(true);
  });
});

describe("Proof Receipt: tampering is caught and named", () => {
  const good = assembleReceipt(input(flawed()));

  // [what, mutation, check that must fail, its detail, top-level section the seal must name]
  it.each<[string, (r: ProofReceipt) => void, string, RegExp, string]>([
    ["a leaf's verdict", (r) => ((r.leaves["verifier-b"]![2] as { verdict: string }).verdict = "pass"), "certificate", /verifier-b: evidence does not match the signed Merkle root/, "leaves"],
    ["a leaf's summary", (r) => ((r.leaves["verifier-a"]![0] as { summary: string }).summary += "!"), "certificate", /verifier-a: evidence does not match/, "leaves"],
    ["a milestone amount in the contract", (r) => ((r.contract as { milestones: { amount_cents: number }[] }).milestones[0]!.amount_cents += 1), "contract", /./, "contract"],
    ["the contract hash", (r) => (r.contract_hash = "f".repeat(64)), "contract_hash", /receipt says f{64}/, "contract_hash"],
    ["a certificate verdict", (r) => ((r.certificate as { items: { verdict: string }[] }).items[2]!.verdict = "pass"), "certificate", /verdicts do not follow/, "certificate"],
    ["an attestation signature", (r) => {
      const att = (r.certificate as { attestations: { signature: string }[] }).attestations[0]!;
      att.signature = (att.signature[0] === "A" ? "B" : "A") + att.signature.slice(1);
    }, "certificate", /signature by verifier-a does not verify/, "certificate"],
    ["the certificate hash", (r) => (r.certificate_hash = "0".repeat(64)), "certificate_hash", /receipt says 0{64}/, "certificate_hash"],
    ["the job ID", (r) => (r.job.id = "job_other"), "certificate", /different job/, "job"],
    ["the deliverable URL", (r) => (r.job.deliverable_url = "https://evil.example/"), "certificate", /different deliverable/, "job"],
    ["a milestone outcome", (r) => (r.milestones[1]!.outcome = "passed"), "milestones", /milestone 1 says passed, the verdicts say failed/, "milestones"],
    ["a milestone title", (r) => (r.milestones[0]!.title = "Other"), "milestones", /does not match the contract/, "milestones"],
    ["a refunded milestone marked released", (r) => (r.milestones[1]!.status = "released"), "milestones", /was released but its outcome is failed/, "milestones"],
    ["a client decision on a quorum item", (r) => r.client_decisions.push({ m: 1, i: 0, decision: "approve", actor: "x", note: null, decided_at: ISSUED }), "client_decisions", /decided by the quorum/, "client_decisions"],
    ["a flipped client decision", (r) => (r.client_decisions[0]!.decision = "reject"), "milestones", /milestone 2 says passed, the verdicts say failed/, "client_decisions"],
    ["a dropped artifact", (r) => r.artifacts.pop(), "artifacts", /does not match the hashes/, "artifacts"],
    ["an artifact URL", (r) => (r.artifacts[0]!.url = "https://evil.example/x.png"), "artifacts", /URL/, "artifacts"],
    ["an unknown top-level field", (r) => ((r as Record<string, unknown>).extra = 1), "format", /malformed/, ""],
  ])("changing %s", (_what, mutate, check, detail, section) => {
    const r = clone(good);
    mutate(r);
    const bad = failed(r);
    const specific = bad.find((c) => c.check === check);
    expect(specific, `expected the ${check} check to fail; failed: ${JSON.stringify(bad)}`).toBeDefined();
    expect(specific!.detail).toMatch(detail);
    if (section) expect(bad.find((c) => c.check === "seal_sections")?.detail).toMatch(new RegExp(`\\b${section}\\b`));
  });

  it("changing Kept's own records (PayPal IDs, events, status, time) breaks the seal and names the section", () => {
    const cases: [(r: ProofReceipt) => void, string][] = [
      [(r) => (r.paypal.order_id = "ORDER-2"), "paypal"],
      [(r) => (r.milestones[0]!.paypal.release_id = "PP-X"), "milestones"],
      [(r) => r.events.push({ type: "X", actor: "x", payload: null, at: ISSUED }), "events"],
      [(r) => (r.job.status = "DISPUTED"), "job"],
      [(r) => (r.issued_at = "2027-01-01T00:00:00.000Z"), "issued_at"],
    ];
    for (const [mutate, section] of cases) {
      const r = clone(good);
      mutate(r);
      expect(failed(r).map((c) => [c.check, c.detail])).toEqual([["seal_sections", `changed since sealing: ${section}`]]);
    }
  });

  it("a forged seal over edited records passes on its own, but not against the published issuer key", () => {
    const forger = loadKeyring([ISSUER_ID], { dir: mkdtempSync(join(tmpdir(), "kept-forger-")) }).get(ISSUER_ID)!;
    const r = clone(good);
    r.paypal.order_id = "ORDER-FORGED";
    const { seal: _seal, ...body } = r;
    const forged = sealReceipt(body, forger);
    expect(verifyReceipt(forged).ok).toBe(true);
    const v = verifyReceipt(forged, { issuerFingerprint: issuer.public.fingerprint });
    expect(v.checks.filter((c) => !c.ok).map((c) => c.check)).toEqual(["issuer_key"]);
    expect(verifyReceipt(good, { issuerFingerprint: issuer.public.fingerprint }).ok).toBe(true);
  });

  it("leaves from a verifier that did not attest are rejected", () => {
    const [a, b, c] = flawed();
    const r = clone(assembleReceipt(input([a!, b!])));
    r.leaves["verifier-c"] = c!.leaves;
    expect(failed(r).map((x) => x.check)).toEqual(["seal_sections", "leaves"]);
  });

  it("never throws on garbage", () => {
    for (const junk of [null, 1, "x", [], {}, { v: "kept-qaps/1" }]) {
      expect(verifyReceipt(junk).ok).toBe(false);
    }
  });
});

// ---------- end to end: real verification, settlement, HTTP route ----------

describe("GET /jobs/:id/receipt (local browsers, mock PayPal)", () => {
  let server: Server;
  let origin: string;
  let db: Db;
  const keyring = loadKeyring(verifierIds(3), { dir: mkdtempSync(join(tmpdir(), "kept-rcpt-keys-")) });
  const store = new EvidenceStore(mkdtempSync(join(tmpdir(), "kept-rcpt-ev-")));

  beforeAll(async () => {
    db = openDb(":memory:");
    seedDemoParties(db, loadConfig({ DEMO_CLIENT_EMAIL: "c@example.com", DEMO_WORKER_EMAIL: "w@example.com" }));
    server = createApp(loadConfig({ PUBLIC_BASE_URL: "https://kept.example" }), { db, keyring, issuer, evidence: store }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  it("is 404 for an unknown job and 409 before verification", async () => {
    expect((await fetch(`${origin}/jobs/job_nope/receipt`)).status).toBe(404);
    const jobId = createDeliveredDemoJob(db, { keyring, deliverableUrl: `${origin}/demo/sites/good/` });
    const res = await fetch(`${origin}/jobs/${jobId}/receipt`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no quorum certificate/);
    expect(() => getReceipt(db, jobId, { publicBaseUrl: origin, issuer })).toThrow(ReceiptUnavailableError);
  });

  it("flawed site: the receipt carries the proof and the PayPal IDs, and verifies offline", async () => {
    const jobId = createDeliveredDemoJob(db, { keyring, deliverableUrl: `${origin}/demo/sites/flawed/` });
    const summary = await verifyJob(db, jobId, {
      keyring,
      store,
      network: { allowOrigins: [origin] },
      panel: (ids, url) => panelBrowsers(ids, { preferKernel: false, deliverableUrl: url }),
      judgeModels: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
      checkTimeoutMs: 8000,
    });
    expect(summary.status).toBe("verified");
    // Any item the quorum left to a person gets a client decision, so settlement can run.
    for (const item of summary.items!.filter((x) => x.verdict === "needs_client")) {
      recordClientDecision(db, { jobId, m: item.m, i: item.i, decision: "approve", actor: "party_demo_client" });
    }

    const before = (await (await fetch(`${origin}/jobs/${jobId}/receipt`)).json()) as ProofReceipt;
    expect(verifyReceipt(before).ok).toBe(true);
    expect(before.certificate_hash).toBe(summary.certificateHash);
    expect(before.milestones.map((m) => m.outcome)).toEqual(summary.outcomes);
    expect(before.milestones.every((m) => m.status === "pending")).toBe(true);

    await settleJob(db, jobId, { rail: new MockRail(), loadProof: loadProofFromDb, actor: "kept" });

    const res = await fetch(`${origin}/jobs/${jobId}/receipt?download=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(new RegExp(`^attachment; filename="?kept-receipt-${jobId}\\.json"?$`));
    const receipt = (await res.json()) as ProofReceipt;
    const v = verifyReceipt(receipt);
    expect(v.checks.filter((c) => !c.ok)).toEqual([]);

    expect(receipt.job).toMatchObject({ id: jobId, status: "SETTLED", deliverable_url: `${origin}/demo/sites/flawed/` });
    expect(receipt.milestones.map((m) => m.status)).toEqual(summary.outcomes!.map((o) => (o === "passed" ? "released" : "refunded")));
    expect(receipt.milestones.filter((m) => m.status === "refunded")).toHaveLength(1);
    for (const m of receipt.milestones) {
      if (m.status === "released") expect(m.paypal.release_id).toMatch(/^PP-RELEASE-/);
      if (m.status === "refunded") expect(m.paypal.refund_id).toMatch(/^PP-REFUND-/);
    }
    const statuses = receipt.events.filter((e) => e.type === "STATUS_CHANGED").map((e) => e.payload?.to);
    expect(statuses).toEqual(expect.arrayContaining(["DELIVERED", "VERIFYING", "VERIFIED", "SETTLED"]));

    // Every artifact the receipt lists is served at its URL path and hashes to its name.
    expect(receipt.artifacts.length).toBeGreaterThan(0);
    for (const a of receipt.artifacts) {
      expect(a.url.startsWith("https://kept.example/evidence/")).toBe(true);
      const body = Buffer.from(await (await fetch(`${origin}${new URL(a.url).pathname}`)).arrayBuffer());
      const { createHash } = await import("node:crypto");
      expect(createHash("sha256").update(body).digest("hex")).toBe(a.sha256);
    }
  }, 120_000);
});
