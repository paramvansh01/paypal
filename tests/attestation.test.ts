import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { attestationBytes, signAttestation, verifyAttestation, type AttestationPayload } from "../src/qaps/attestation.js";
import {
  fingerprintOf,
  KeyError,
  keyringToJson,
  loadKeyring,
  publicKeyring,
  verifySignature,
  VerifierKey,
} from "../src/qaps/keys.js";
import { verifierIds } from "../src/qaps/protocol.js";
import { createApp } from "../src/server/app.js";

const tempDir = () => mkdtempSync(join(tmpdir(), "kept-keys-"));

const payload = (over: Partial<AttestationPayload> = {}): AttestationPayload => ({
  v: "kept-qaps/1",
  type: "attestation",
  job_id: "job_123",
  contract_hash: "a".repeat(64),
  deliverable_url: "https://example.com/site/",
  verifier_id: "verifier-a",
  browser: "chromium-local",
  judge_model: "claude-opus-5-5",
  merkle_root: "b".repeat(64),
  leaf_count: 5,
  issued_at: "2026-11-10T12:00:00.000Z",
  ...over,
});

describe("verifier keys", () => {
  it("names verifiers a, b, c…", () => {
    expect(verifierIds(3)).toEqual(["verifier-a", "verifier-b", "verifier-c"]);
    expect(() => verifierIds(0)).toThrow(RangeError);
  });

  it("creates keys once, with owner-only permissions, and reloads the same keys", () => {
    const dir = tempDir();
    const first = loadKeyring(verifierIds(3), { dir });
    const second = loadKeyring(verifierIds(3), { dir });
    for (const id of verifierIds(3)) {
      expect(second.get(id)!.public).toEqual(first.get(id)!.public);
      expect(statSync(join(dir, `${id}.jwk.json`)).mode & 0o777).toBe(0o600);
    }
    // Distinct keys per verifier.
    expect(new Set([...first.values()].map((k) => k.public.public_key)).size).toBe(3);
  });

  it("loads keys from VERIFIER_KEYS_JSON and requires every verifier", () => {
    const ring = loadKeyring(verifierIds(2), { dir: tempDir() });
    const json = keyringToJson(ring);
    const again = loadKeyring(verifierIds(2), { dir: "/nonexistent", json });
    expect(again.get("verifier-b")!.public).toEqual(ring.get("verifier-b")!.public);
    expect(() => loadKeyring(verifierIds(3), { dir: "/nonexistent", json })).toThrow(/no key for verifier-c/);
    expect(() => loadKeyring(verifierIds(1), { dir: "/x", json: "{oops" })).toThrow(KeyError);
  });

  it("rejects a stored key whose public half was swapped", () => {
    const dir = tempDir();
    loadKeyring(["verifier-a"], { dir });
    const file = join(dir, "verifier-a.jwk.json");
    const jwk = JSON.parse(readFileSync(file, "utf8"));
    jwk.x = VerifierKey.generate("other").public.public_key;
    writeFileSync(file, JSON.stringify(jwk));
    expect(() => loadKeyring(["verifier-a"], { dir })).toThrow(/does not match the private key/);
  });

  it("fingerprint is SHA-256 of the raw 32-byte key", () => {
    const k = VerifierKey.generate("verifier-a");
    expect(Buffer.from(k.public.public_key, "base64url")).toHaveLength(32);
    expect(k.public.fingerprint).toBe(fingerprintOf(k.public.public_key));
    expect(k.public.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts only the canonical base64url spelling of a signature", () => {
    const a = VerifierKey.generate("verifier-a");
    const msg = Buffer.from("hello");
    const sig = a.sign(msg);
    // The last of 86 characters carries 4 unused bits, so other spellings decode to the same bytes.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const twins = [...alphabet]
      .map((c) => sig.slice(0, -1) + c)
      .filter((s) => s !== sig && Buffer.from(s, "base64url").equals(Buffer.from(sig, "base64url")));
    expect(twins.length).toBeGreaterThan(0);
    expect(verifySignature(a.public, msg, sig)).toBe(true);
    for (const t of twins) expect(verifySignature(a.public, msg, t)).toBe(false);
  });

  it("raw signatures verify only with the right key and message", () => {
    const a = VerifierKey.generate("verifier-a");
    const b = VerifierKey.generate("verifier-b");
    const msg = Buffer.from("hello");
    const sig = a.sign(msg);
    expect(verifySignature(a.public, msg, sig)).toBe(true);
    expect(verifySignature(b.public, msg, sig)).toBe(false);
    expect(verifySignature(a.public, Buffer.from("hellp"), sig)).toBe(false);
    expect(verifySignature(a.public, msg, sig.slice(0, -2))).toBe(false);
    expect(verifySignature(a.public, msg, "not base64!")).toBe(false);
    expect(verifySignature({ ...a.public, public_key: "AAAA" }, msg, sig)).toBe(false);
  });
});

describe("attestations", () => {
  const ring = loadKeyring(verifierIds(3), { dir: tempDir() });
  const trusted = publicKeyring(ring).verifiers;
  const keyA = ring.get("verifier-a")!;

  it("a signed attestation verifies", () => {
    const att = signAttestation(payload(), keyA);
    expect(att.key_fingerprint).toBe(keyA.public.fingerprint);
    expect(verifyAttestation(att, trusted)).toEqual({ ok: true });
  });

  it("signs the canonical form, so key order in transit does not matter", () => {
    const att = signAttestation(payload(), keyA);
    const reordered = { ...att, payload: Object.fromEntries(Object.entries(att.payload).reverse()) };
    expect(verifyAttestation(JSON.parse(JSON.stringify(reordered)), trusted)).toEqual({ ok: true });
    expect(attestationBytes(att.payload).toString()).toMatch(/^\{"browser":/);
  });

  // Every field is covered by the signature, including the leaf count that pins the tree size.
  const fieldChanges: [keyof AttestationPayload, unknown][] = [
    ["job_id", "job_124"],
    ["contract_hash", "c".repeat(64)],
    ["deliverable_url", "https://example.com/other/"],
    ["browser", "webkit-local"],
    ["judge_model", "claude-haiku-5-5"],
    ["merkle_root", "d".repeat(64)],
    ["leaf_count", 6],
    ["issued_at", "2026-11-10T12:00:01.000Z"],
  ];
  it.each(fieldChanges)("changing %s breaks the signature", (field, value) => {
    const att = signAttestation(payload(), keyA);
    const tampered = { ...att, payload: { ...att.payload, [field]: value } };
    expect(verifyAttestation(tampered, trusted)).toEqual({ ok: false, reason: "signature by verifier-a does not verify" });
  });

  it("claiming to be another verifier fails", () => {
    const att = signAttestation(payload(), keyA);
    const forged = { ...att, payload: { ...att.payload, verifier_id: "verifier-b" } };
    expect(verifyAttestation(forged, trusted)).toMatchObject({ ok: false, reason: expect.stringMatching(/fingerprint/) });
    const forged2 = { ...forged, key_fingerprint: ring.get("verifier-b")!.public.fingerprint };
    expect(verifyAttestation(forged2, trusted)).toMatchObject({ ok: false, reason: expect.stringMatching(/does not verify/) });
  });

  it("refuses to sign for a different verifier ID", () => {
    expect(() => signAttestation(payload({ verifier_id: "verifier-b" }), keyA)).toThrow(/cannot sign/);
  });

  it("rejects unknown verifiers and untrusted keys", () => {
    const outsider = VerifierKey.generate("verifier-z");
    const att = signAttestation(payload({ verifier_id: "verifier-z" }), outsider);
    expect(verifyAttestation(att, trusted)).toEqual({ ok: false, reason: "unknown verifier verifier-z" });
    // Same ID as a trusted verifier but a different key.
    const impostor = VerifierKey.generate("verifier-a");
    expect(verifyAttestation(signAttestation(payload(), impostor), trusted)).toMatchObject({ ok: false });
  });

  it("rejects malformed attestations without throwing", () => {
    const att = signAttestation(payload(), keyA);
    expect(verifyAttestation(null, trusted)).toMatchObject({ ok: false, reason: expect.stringMatching(/malformed/) });
    expect(verifyAttestation({ ...att, extra: 1 }, trusted)).toMatchObject({ ok: false });
    expect(verifyAttestation({ ...att, payload: { ...att.payload, v: "kept-qaps/2" } }, trusted)).toMatchObject({ ok: false });
    expect(verifyAttestation({ ...att, payload: { ...att.payload, merkle_root: "B".repeat(64) } }, trusted)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/merkle_root/),
    });
  });
});

describe("GET /.well-known/kept/verifiers.json", () => {
  it("publishes the public keys only", async () => {
    const ring = loadKeyring(verifierIds(3), { dir: tempDir() });
    const server: Server = createApp(loadConfig({}), { keyring: ring }).listen(0);
    await new Promise((r) => server.once("listening", r));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/.well-known/kept/verifiers.json`);
      const body = await res.json();
      expect(body).toEqual(publicKeyring(ring));
      expect(JSON.stringify(body)).not.toMatch(/"d"/);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
