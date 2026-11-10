import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject, type webcrypto } from "node:crypto";

type JsonWebKey = webcrypto.JsonWebKey;
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL } from "./protocol.js";

/**
 * Each verifier signs with its own Ed25519 key (RFC 8032, Node's built-in crypto).
 * Keys are stored as JWK so browsers can import the public half with WebCrypto.
 */

export interface VerifierPublicKey {
  id: string;
  alg: "Ed25519";
  /** Raw 32-byte public key, base64url (the JWK `x` value). */
  public_key: string;
  /** SHA-256 of the raw public key, hex. */
  fingerprint: string;
}

export interface PublicKeyring {
  protocol: typeof PROTOCOL;
  verifiers: VerifierPublicKey[];
}

export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

const B64URL = /^[A-Za-z0-9_-]+$/;

export function fingerprintOf(publicKeyB64url: string): string {
  return createHash("sha256").update(Buffer.from(publicKeyB64url, "base64url")).digest("hex");
}

export class VerifierKey {
  readonly public: VerifierPublicKey;
  private constructor(
    readonly id: string,
    private readonly privateKey: KeyObject,
    publicX: string,
  ) {
    this.public = { id, alg: "Ed25519", public_key: publicX, fingerprint: fingerprintOf(publicX) };
  }

  static generate(id: string): VerifierKey {
    const { privateKey } = generateKeyPairSync("ed25519");
    return VerifierKey.fromPrivateJwk(id, privateKey.export({ format: "jwk" }));
  }

  static fromPrivateJwk(id: string, jwk: JsonWebKey): VerifierKey {
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.d !== "string" || typeof jwk.x !== "string") {
      throw new KeyError(`key for ${id} is not an Ed25519 private JWK`);
    }
    let privateKey: KeyObject;
    try {
      privateKey = createPrivateKey({ key: jwk, format: "jwk" });
    } catch (err) {
      throw new KeyError(`key for ${id} could not be loaded: ${(err as Error).message}`);
    }
    // Derive the public key ourselves rather than trusting the stored `x`.
    const x = createPublicKey(privateKey).export({ format: "jwk" }).x!;
    if (x !== jwk.x) throw new KeyError(`key for ${id}: stored public key does not match the private key`);
    return new VerifierKey(id, privateKey, x);
  }

  toPrivateJwk(): JsonWebKey {
    return this.privateKey.export({ format: "jwk" });
  }

  /** Ed25519 signature over the exact bytes, base64url. */
  sign(message: Uint8Array): string {
    return sign(null, message, this.privateKey).toString("base64url");
  }
}

/** Verifies an Ed25519 signature against a published key. Never throws. */
export function verifySignature(key: VerifierPublicKey, message: Uint8Array, signatureB64url: string): boolean {
  try {
    if (!B64URL.test(signatureB64url) || !B64URL.test(key.public_key)) return false;
    const sig = Buffer.from(signatureB64url, "base64url");
    const raw = Buffer.from(key.public_key, "base64url");
    if (sig.length !== 64 || raw.length !== 32) return false;
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.public_key }, format: "jwk" });
    return verify(null, message, publicKey, sig);
  } catch {
    return false;
  }
}

export type Keyring = ReadonlyMap<string, VerifierKey>;

/**
 * Loads one key per verifier ID. With `json` (VERIFIER_KEYS_JSON), every ID
 * must be present there. Otherwise keys are read from `dir`, and any missing
 * key is generated and written with owner-only permissions.
 */
export function loadKeyring(ids: readonly string[], opts: { dir: string; json?: string }): Keyring {
  const ring = new Map<string, VerifierKey>();
  if (opts.json) {
    let parsed: Record<string, JsonWebKey>;
    try {
      parsed = JSON.parse(opts.json) as Record<string, JsonWebKey>;
    } catch {
      throw new KeyError("VERIFIER_KEYS_JSON is not valid JSON");
    }
    for (const id of ids) {
      const jwk = parsed[id];
      if (!jwk) throw new KeyError(`VERIFIER_KEYS_JSON has no key for ${id}`);
      ring.set(id, VerifierKey.fromPrivateJwk(id, jwk));
    }
    return ring;
  }
  mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  for (const id of ids) {
    const file = join(opts.dir, `${id}.jwk.json`);
    if (existsSync(file)) {
      ring.set(id, VerifierKey.fromPrivateJwk(id, JSON.parse(readFileSync(file, "utf8")) as JsonWebKey));
      continue;
    }
    const key = VerifierKey.generate(id);
    try {
      // 'wx' fails if another process created the file first; then we load theirs.
      writeFileSync(file, JSON.stringify(key.toPrivateJwk()), { flag: "wx", mode: 0o600 });
      chmodSync(file, 0o600);
      ring.set(id, key);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      ring.set(id, VerifierKey.fromPrivateJwk(id, JSON.parse(readFileSync(file, "utf8")) as JsonWebKey));
    }
  }
  return ring;
}

export function publicKeyring(ring: Keyring): PublicKeyring {
  return { protocol: PROTOCOL, verifiers: [...ring.values()].map((k) => k.public) };
}

/** Serialises a keyring for VERIFIER_KEYS_JSON (keep it secret). */
export function keyringToJson(ring: Keyring): string {
  return JSON.stringify(Object.fromEntries([...ring].map(([id, k]) => [id, k.toPrivateJwk()])));
}
