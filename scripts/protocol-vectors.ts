/**
 * npm run protocol-vectors            print the Kept Protocol v1 test vectors
 * npm run protocol-vectors -- --write  regenerate docs/protocol-vectors.json
 *
 * Everything is deterministic: fixed Ed25519 seeds (Ed25519 signatures are
 * deterministic), fixed timestamps. tests/protocol-vectors.test.ts regenerates
 * the vectors and fails if they differ from the committed file, so the spec's
 * numbers always match the code.
 */
import { createHash, createPrivateKey } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalJson, checklistHash, contractItems, parseChecklist, type ChecklistInput } from "../src/core/checklist.js";
import { signAttestation } from "../src/qaps/attestation.js";
import { VerifierKey } from "../src/qaps/keys.js";
import { evidenceRoot, leafBytes, type LeafRecord, type Vote } from "../src/qaps/leaf.js";
import { leafHash, nodeHash, rootFromLeafHashes, toHex } from "../src/qaps/merkle.js";
import { PROTOCOL } from "../src/qaps/protocol.js";
import { buildCertificate, certificateHash, decideItem } from "../src/qaps/quorum.js";
import { assembleReceipt, ISSUER_ID, sealReceipt, verifyReceipt, type ProofReceipt } from "../src/qaps/receipt.js";

export const VECTORS_PATH = fileURLToPath(new URL("../docs/protocol-vectors.json", import.meta.url));
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

/** A fixed key: seed = SHA-256("kept-protocol-vectors:" + id). Test use only. */
function fixedKey(id: string): { key: VerifierKey; seed_hex: string } {
  const seed = createHash("sha256").update(`kept-protocol-vectors:${id}`).digest();
  const jwk = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" }).export({ format: "jwk" });
  return { key: VerifierKey.fromPrivateJwk(id, jwk), seed_hex: seed.toString("hex") };
}

export function buildVectors() {
  const ids = ["verifier-a", "verifier-b", "verifier-c"];
  const vkeys = ids.map(fixedKey);
  const issuer = fixedKey(ISSUER_ID);
  const JOB = "job_vectors01";
  const URL_ = "https://deliverable.example/site/";
  const ISSUED = "2026-11-10T12:00:00.000Z";

  // 1. Canonical JSON
  const canonicalInput = { b: [3, 1, { z: true, a: null }], a: "é \"quoted\"", "A": -7, "_": { y: 1, x: 2 } };
  const canonical = { input: canonicalInput, output: canonicalJson(canonicalInput) };

  // 2. Contract: written with defaults omitted, then normalised.
  const contractInput: ChecklistInput = {
    version: 1,
    currency: "USD",
    total_cents: 5000,
    quorum: { n: 3, k: 2, verifiers: vkeys.map(({ key }) => ({ id: key.id, public_key: key.public.public_key })) },
    milestones: [
      {
        title: "Page live",
        amount_cents: 3000,
        items: [
          { description: "Loads", check_type: "http_status", params: {} },
          { description: "Shows the name", check_type: "text_present", params: { text: "Acme" } },
        ],
      },
      { title: "Design approved", amount_cents: 2000, items: [{ description: "Client likes it", check_type: "client_approval", params: {} }] },
    ],
  } as ChecklistInput;
  const contract = parseChecklist(contractInput);
  const contractVec = {
    input_with_defaults_omitted: contractInput,
    normalised: contract,
    canonical_json: canonicalJson(contract),
    contract_hash: checklistHash(contract),
  };

  // 3. Leaves and Merkle roots. a and b pass the text check, c fails it.
  const votes: Record<string, Vote[]> = {
    "verifier-a": ["pass", "pass", "needs_client"],
    "verifier-b": ["pass", "pass", "needs_client"],
    "verifier-c": ["pass", "fail", "needs_client"],
  };
  const shot = (s: string) => createHash("sha256").update(s).digest("hex");
  const leaves: Record<string, LeafRecord[]> = Object.fromEntries(
    ids.map((id) => [
      id,
      contractItems(contract).map(({ m, i, item }, idx): LeafRecord => ({
        m,
        i,
        check_type: item.check_type,
        verdict: votes[id]![idx]!,
        injection: false,
        measured_value: item.check_type === "http_status" ? "200" : null,
        summary: `${id}: ${votes[id]![idx]}`,
        artifacts:
          item.check_type === "client_approval"
            ? { details_sha256: shot(`details-${idx}`) }
            : { details_sha256: shot(`details-${idx}`), screenshot_sha256: shot(`screenshot-${idx}`) },
      })),
    ]),
  );
  const merkle = ids.map((id) => ({
    verifier_id: id,
    leaf_canonical_json: leaves[id]!.map((l) => leafBytes(l).toString("utf8")),
    leaf_hashes: leaves[id]!.map((l) => toHex(leafHash(leafBytes(l)))),
    merkle_root: evidenceRoot(leaves[id]!),
  }));
  const rfc6962 = (() => {
    const data = ["", "a", "b"].map((s) => Buffer.from(s, "utf8"));
    const hs = data.map((d) => leafHash(d));
    return {
      leaf_inputs_utf8: ["", "a", "b"],
      leaf_hashes: hs.map(toHex),
      root_of_first_two: toHex(nodeHash(hs[0]!, hs[1]!)),
      root_of_all_three: toHex(rootFromLeafHashes(hs)),
      empty_root: toHex(rootFromLeafHashes([])),
    };
  })();

  // 4. Attestations and the certificate.
  const reports = vkeys.map(({ key }) => ({
    attestation: signAttestation(
      {
        v: PROTOCOL,
        type: "attestation",
        job_id: JOB,
        contract_hash: contractVec.contract_hash,
        deliverable_url: URL_,
        verifier_id: key.id,
        browser: "local-chromium 140.0",
        judge_model: "claude-opus-5-5",
        merkle_root: evidenceRoot(leaves[key.id]!),
        leaf_count: leaves[key.id]!.length,
        issued_at: ISSUED,
      },
      key,
    ),
    leaves: leaves[key.id]!,
  }));
  const { certificate } = buildCertificate({ job_id: JOB, contract, deliverable_url: URL_, reports, issued_at: ISSUED });
  const attestations = reports.map((r) => ({
    signed_bytes_utf8: canonicalJson(r.attestation.payload),
    attestation: r.attestation,
  }));
  const quorumRule = [
    { check_type: "text_present", k: 2, ballots: [{ verdict: "pass", injection: false }, { verdict: "pass", injection: false }, { verdict: "fail", injection: false }] },
    { check_type: "text_present", k: 2, ballots: [{ verdict: "pass", injection: false }, { verdict: "fail", injection: false }, { verdict: "error", injection: false }] },
    { check_type: "form_submits", k: 2, ballots: [{ verdict: "pass", injection: true }, { verdict: "pass", injection: false }, { verdict: "fail", injection: false }] },
    { check_type: "form_submits", k: 2, ballots: [{ verdict: "fail", injection: true }, { verdict: "pass", injection: true }, { verdict: "pass", injection: false }] },
    { check_type: "client_approval", k: 2, ballots: [{ verdict: "pass", injection: false }, { verdict: "pass", injection: false }, { verdict: "pass", injection: false }] },
  ].map((c) => ({ ...c, decision: decideItem(c.check_type, c.ballots as { verdict: Vote; injection: boolean }[], c.k) }));

  // 5. The receipt (client approved the design item; everything settled).
  const receipt: ProofReceipt = assembleReceipt({
    job: { id: JOB, title: "Acme site", status: "SETTLED", rail: "auth_capture", deliverable_url: URL_ },
    contract,
    certificate,
    leaves,
    clientDecisions: [{ m: 1, i: 0, decision: "approve", actor: "party_client", note: null, decided_at: ISSUED }],
    milestones: contract.milestones.map((m, idx) => ({
      title: m.title,
      amount_cents: m.amount_cents,
      status: "released",
      paypal: { capture_id: "CAPTURE-1", release_id: `RELEASE-${idx + 1}`, refund_id: null },
    })),
    paypalOrderId: "ORDER-1",
    events: [{ type: "STATUS_CHANGED", actor: "kept", payload: { from: "VERIFIED", to: "SETTLED" }, at: ISSUED }],
    publicBaseUrl: "https://kept.example",
    issuedAt: ISSUED,
    issuer: issuer.key,
  });
  const { seal: _seal, ...unsealed } = receipt;
  const resealed = sealReceipt(unsealed, issuer.key);
  if (canonicalJson(resealed) !== canonicalJson(receipt)) throw new Error("sealing is not deterministic");

  const tampered = structuredClone(receipt);
  tampered.milestones[0]!.paypal.release_id = "RELEASE-X";

  return {
    protocol: PROTOCOL,
    note: "Test vectors for docs/PROTOCOL.md. Keys are derived from public seeds: never use them for anything real.",
    keys: [...vkeys, issuer].map(({ key, seed_hex }) => ({
      id: key.id,
      seed_hex,
      public_key: key.public.public_key,
      fingerprint: key.public.fingerprint,
    })),
    canonical_json: canonical,
    contract: contractVec,
    rfc6962,
    merkle,
    attestations,
    certificate: { certificate, certificate_hash: certificateHash(certificate) },
    quorum_rule: quorumRule,
    receipt: { receipt, expected: verifyReceipt(receipt, { issuerFingerprint: issuer.key.public.fingerprint }) },
    tampered_receipt: {
      change: "milestones[0].paypal.release_id changed from RELEASE-1 to RELEASE-X",
      receipt: tampered,
      expected: verifyReceipt(tampered, { issuerFingerprint: issuer.key.public.fingerprint }),
    },
  };
}

export const vectorsJson = () => `${JSON.stringify(buildVectors(), null, 2)}\n`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const json = vectorsJson();
  if (process.argv.includes("--write")) {
    writeFileSync(VECTORS_PATH, json);
    console.log(`wrote ${VECTORS_PATH}`);
  } else process.stdout.write(json);
}
