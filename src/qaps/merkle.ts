import { createHash } from "node:crypto";

/**
 * Merkle tree exactly as Certificate Transparency defines it.
 *
 *   Tree hash: RFC 6962 §2.1 (Merkle Tree Hash, MTH)
 *   Audit path: RFC 6962 §2.1.1 (PATH)
 *   Verification: RFC 9162 §2.1.3.2
 *
 * Leaves and interior nodes use different one-byte prefixes (0x00, 0x01), so a
 * leaf can never be passed off as an interior node (second-preimage defence).
 * Tested against the transparency-dev/merkle reference vectors.
 */

export type Hash = Buffer;
export const HASH_SIZE = 32;

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

const sha256 = (...parts: Uint8Array[]): Hash => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

/** Root of a tree with no leaves: SHA-256 of the empty string. */
export const EMPTY_ROOT: Hash = sha256();

export function leafHash(data: Uint8Array | string): Hash {
  return sha256(LEAF_PREFIX, typeof data === "string" ? Buffer.from(data, "utf8") : data);
}

export function nodeHash(left: Uint8Array, right: Uint8Array): Hash {
  return sha256(NODE_PREFIX, left, right);
}

/** Largest power of two strictly smaller than n (n ≥ 2). */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** MTH over already-hashed leaves. */
export function rootFromLeafHashes(leaves: readonly Hash[]): Hash {
  if (leaves.length === 0) return EMPTY_ROOT;
  if (leaves.length === 1) return leaves[0]!;
  const k = splitPoint(leaves.length);
  return nodeHash(rootFromLeafHashes(leaves.slice(0, k)), rootFromLeafHashes(leaves.slice(k)));
}

/** Audit path for leaf m: the sibling hashes from the leaf up to the root. */
export function inclusionProof(leaves: readonly Hash[], m: number): Hash[] {
  if (!Number.isInteger(m) || m < 0 || m >= leaves.length) {
    throw new RangeError(`leaf index ${m} out of range for a tree of ${leaves.length}`);
  }
  if (leaves.length === 1) return [];
  const k = splitPoint(leaves.length);
  return m < k
    ? [...inclusionProof(leaves.slice(0, k), m), rootFromLeafHashes(leaves.slice(k))]
    : [...inclusionProof(leaves.slice(k), m - k), rootFromLeafHashes(leaves.slice(0, k))];
}

const isHash = (h: unknown): h is Uint8Array => h instanceof Uint8Array && h.length === HASH_SIZE;

/**
 * RFC 9162 §2.1.3.2. Returns true only if `leaf` is at `index` in a tree of
 * `treeSize` leaves whose root is `root`. Never throws on bad input.
 */
export function verifyInclusion(
  index: number,
  treeSize: number,
  leaf: Uint8Array,
  proof: readonly Uint8Array[],
  root: Uint8Array,
): boolean {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(treeSize) || index < 0) return false;
  if (index >= treeSize) return false;
  if (!isHash(leaf) || !isHash(root) || !proof.every(isHash)) return false;

  let fn = index;
  let sn = treeSize - 1;
  let r: Uint8Array = leaf;
  const lsb = (x: number) => x % 2 === 1;
  const shift = (x: number) => Math.floor(x / 2);

  for (const p of proof) {
    if (sn === 0) return false;
    if (lsb(fn) || fn === sn) {
      r = nodeHash(p, r);
      if (!lsb(fn)) {
        while (!lsb(fn) && fn !== 0) {
          fn = shift(fn);
          sn = shift(sn);
        }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn = shift(fn);
    sn = shift(sn);
  }
  return sn === 0 && Buffer.from(r).equals(Buffer.from(root));
}

/** Convenience wrapper: build once, then ask for the root or any proof. */
export class MerkleTree {
  readonly leafHashes: readonly Hash[];
  readonly root: Hash;

  constructor(leafData: readonly (Uint8Array | string)[]) {
    this.leafHashes = leafData.map(leafHash);
    this.root = rootFromLeafHashes(this.leafHashes);
  }

  get size(): number {
    return this.leafHashes.length;
  }

  proof(index: number): Hash[] {
    return inclusionProof(this.leafHashes, index);
  }
}

export const toHex = (h: Uint8Array): string => Buffer.from(h).toString("hex");
export const fromHex = (s: string): Hash => {
  if (!/^(?:[0-9a-f]{2})*$/i.test(s)) throw new TypeError("not a hex string");
  return Buffer.from(s, "hex");
};
