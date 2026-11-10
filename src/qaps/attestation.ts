import { z } from "zod";
import { canonicalJson } from "../core/checklist.js";
import { verifySignature, type VerifierKey, type VerifierPublicKey } from "./keys.js";
import { HEX64, PROTOCOL } from "./protocol.js";

/**
 * An attestation is one verifier's signed statement: "for this contract and
 * this deliverable, my evidence Merkle tree has this root and this many leaves".
 * The signature covers the canonical JSON of the payload, byte for byte.
 */

const hex64 = z.string().regex(HEX64, "must be 64 lowercase hex characters");

export const AttestationPayload = z.strictObject({
  v: z.literal(PROTOCOL),
  type: z.literal("attestation"),
  job_id: z.string().min(1).max(100),
  contract_hash: hex64,
  deliverable_url: z.url().max(2000),
  verifier_id: z.string().min(1).max(64),
  browser: z.string().min(1).max(100),
  judge_model: z.string().min(1).max(100),
  merkle_root: hex64,
  leaf_count: z.number().int().min(0).max(10_000),
  issued_at: z.iso.datetime(),
});
export type AttestationPayload = z.infer<typeof AttestationPayload>;

export const SignedAttestation = z.strictObject({
  payload: AttestationPayload,
  /** Ed25519 over canonicalJson(payload), base64url. */
  signature: z.string().min(1).max(200),
  /** Fingerprint of the signing key, so a reader can find it in the published key list. */
  key_fingerprint: hex64,
});
export type SignedAttestation = z.infer<typeof SignedAttestation>;

export function attestationBytes(payload: AttestationPayload): Buffer {
  return Buffer.from(canonicalJson(payload), "utf8");
}

export function signAttestation(payload: AttestationPayload, key: VerifierKey): SignedAttestation {
  const p = AttestationPayload.parse(payload);
  if (p.verifier_id !== key.id) {
    throw new Error(`key ${key.id} cannot sign an attestation for ${p.verifier_id}`);
  }
  return { payload: p, signature: key.sign(attestationBytes(p)), key_fingerprint: key.public.fingerprint };
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/**
 * Checks an attestation against the trusted key list. Never throws; returns a
 * reason a person can act on when it fails.
 */
export function verifyAttestation(input: unknown, trusted: readonly VerifierPublicKey[]): Verdict {
  const parsed = SignedAttestation.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, reason: `malformed attestation: ${first?.path.join(".") || "(root)"} ${first?.message ?? ""}`.trim() };
  }
  const att = parsed.data;
  const key = trusted.find((k) => k.id === att.payload.verifier_id);
  if (!key) return { ok: false, reason: `unknown verifier ${att.payload.verifier_id}` };
  if (key.fingerprint !== att.key_fingerprint) {
    return { ok: false, reason: `key fingerprint does not match the published key for ${key.id}` };
  }
  if (!verifySignature(key, attestationBytes(att.payload), att.signature)) {
    return { ok: false, reason: `signature by ${key.id} does not verify` };
  }
  return { ok: true };
}
