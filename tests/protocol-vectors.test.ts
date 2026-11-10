import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { verifyReceipt as verifyTs } from "../src/qaps/receipt.js";
// @ts-expect-error -- plain .mjs without type declarations, on purpose
import * as standalone from "../tools/verify-receipt.mjs";
import { VECTORS_PATH, vectorsJson } from "../scripts/protocol-vectors.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const mjs = standalone as {
  canonicalJson: (v: unknown) => string;
  merkleRoot: (leaves: Buffer[]) => string;
  decideItem: (t: string, b: unknown[], k: number) => unknown;
  verifyReceipt: (r: unknown, o?: { issuerFingerprint?: string }) => { ok: boolean; checks: { check: string; ok: boolean; detail: string }[] };
};
const committed = readFileSync(VECTORS_PATH, "utf8");
const v = JSON.parse(committed) as Record<string, any>;
const sha256 = async (s: string) => (await import("node:crypto")).createHash("sha256").update(s, "utf8").digest("hex");

describe("docs/protocol-vectors.json", () => {
  it("matches what the code generates today (run `npm run protocol-vectors -- --write` after a deliberate format change)", () => {
    expect(vectorsJson()).toBe(committed);
  });

  it("recomputes independently with the standalone verifier's primitives", async () => {
    expect(mjs.canonicalJson(v.canonical_json.input)).toBe(v.canonical_json.output);
    expect(mjs.canonicalJson(v.contract.normalised)).toBe(v.contract.canonical_json);
    expect(await sha256(v.contract.canonical_json)).toBe(v.contract.contract_hash);
    // The Certificate Transparency leaf hash of the empty string (RFC 6962).
    expect(v.rfc6962.leaf_hashes[0]).toBe("6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d");
    expect(mjs.merkleRoot(v.rfc6962.leaf_inputs_utf8.map((s: string) => Buffer.from(s, "utf8")))).toBe(v.rfc6962.root_of_all_three);
    expect(mjs.merkleRoot([])).toBe(v.rfc6962.empty_root);
    for (const m of v.merkle) {
      expect(mjs.merkleRoot(m.leaf_canonical_json.map((s: string) => Buffer.from(s, "utf8")))).toBe(m.merkle_root);
    }
  });

  it("every attestation signature verifies with plain node:crypto over the stated bytes", () => {
    for (const { signed_bytes_utf8, attestation } of v.attestations) {
      expect(mjs.canonicalJson(attestation.payload)).toBe(signed_bytes_utf8);
      const key = v.keys.find((k: { id: string }) => k.id === attestation.payload.verifier_id);
      const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.public_key }, format: "jwk" });
      expect(verify(null, Buffer.from(signed_bytes_utf8, "utf8"), pub, Buffer.from(attestation.signature, "base64url"))).toBe(true);
      expect(attestation.key_fingerprint).toBe(key.fingerprint);
    }
  });

  it("the quorum-rule vectors hold in both implementations", async () => {
    const { decideItem } = await import("../src/qaps/quorum.js");
    for (const c of v.quorum_rule) {
      expect(decideItem(c.check_type, c.ballots, c.k)).toEqual(c.decision);
      expect(mjs.decideItem(c.check_type, c.ballots, c.k)).toEqual(c.decision);
    }
  });

  it("both receipt verifiers give exactly the expected results for the receipt and the tampered receipt", () => {
    const issuer = v.keys.find((k: { id: string }) => k.id === "kept-issuer").fingerprint;
    for (const verify of [verifyTs, mjs.verifyReceipt]) {
      expect(verify(v.receipt.receipt, { issuerFingerprint: issuer }).checks.map((c) => [c.check, c.ok])).toEqual(
        v.receipt.expected.checks.map((c: { check: string; ok: boolean }) => [c.check, c.ok]),
      );
      const tampered = verify(v.tampered_receipt.receipt, { issuerFingerprint: issuer });
      expect(tampered.checks.filter((c) => !c.ok)).toEqual([{ check: "seal_sections", ok: false, detail: "changed since sealing: milestones" }]);
    }
  });

  it("PROTOCOL.md quotes the vector contract hash and the check names the verifiers use", () => {
    const doc = readFileSync(new URL("../docs/PROTOCOL.md", import.meta.url), "utf8");
    expect(doc).toContain(v.contract.contract_hash);
    for (const c of v.receipt.expected.checks) expect(doc).toContain(`\`${c.check}\``);
  });
});
