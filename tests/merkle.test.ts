import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EMPTY_ROOT,
  fromHex,
  inclusionProof,
  leafHash,
  MerkleTree,
  nodeHash,
  rootFromLeafHashes,
  toHex,
  verifyInclusion,
} from "../src/qaps/merkle.js";

// Reference vectors: transparency-dev/merkle testonly/constants.go (see tests/fixtures/README.md).
const LEAF_INPUTS = ["", "00", "10", "2021", "3031", "40414243", "5051525354555657", "606162636465666768696a6b6c6d6e6f"].map(
  fromHex,
);
const LEAF_HASHES = [
  "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
  "96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7",
  "0298d122906dcfc10892cb53a73992fc5b9f493ea4c9badb27b791b4127a7fe7",
  "07506a85fd9dd2f120eb694f86011e5bb4662e5c415a62917033d4a9624487e7",
  "bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b",
  "4271a26be0d8a84f0bd54c8c302e7cb3a3b5d1fa6780a40bcce2873477dab658",
  "b08693ec2e721597130641e8211e7eedccb4c26413963eee6c1e2ed16ffb1a5f",
  "46f6ffadd3d06a09ff3c5860d2755c8b9819db7df44251788c7d8e3180de8eb1",
];
const ROOTS_BY_SIZE = [
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
  "fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125",
  "aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77",
  "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
  "4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4",
  "76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef",
  "ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c",
  "5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328",
];

interface Probe {
  file: string;
  leafIdx: number;
  treeSize: number;
  root: string | null;
  leafHash: string | null;
  proof: (string | null)[];
  desc: string;
  wantErr: boolean;
}
const PROBES: Probe[] = JSON.parse(readFileSync(new URL("./fixtures/ct-inclusion-probes.json", import.meta.url), "utf8"));

/** Small deterministic PRNG so property tests are repeatable. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

describe("RFC 6962 hashing (reference vectors)", () => {
  it("hashes each leaf with the 0x00 prefix", () => {
    expect(LEAF_INPUTS.map((d) => toHex(leafHash(d)))).toEqual(LEAF_HASHES);
  });

  it("empty tree root is SHA-256 of nothing", () => {
    expect(toHex(EMPTY_ROOT)).toBe(ROOTS_BY_SIZE[0]);
    expect(toHex(rootFromLeafHashes([]))).toBe(ROOTS_BY_SIZE[0]);
  });

  it.each(ROOTS_BY_SIZE.map((root, size) => [size, root] as const))("root of the first %i leaves", (size, root) => {
    expect(toHex(new MerkleTree(LEAF_INPUTS.slice(0, size)).root)).toBe(root);
  });
});

describe("inclusion proofs (reference probes)", () => {
  const decode = (p: Probe) => ({
    root: p.root === null ? Buffer.alloc(0) : fromHex(p.root),
    leaf: p.leafHash === null ? Buffer.alloc(0) : fromHex(p.leafHash),
    proof: p.proof.map((x) => (x === null ? Buffer.alloc(0) : fromHex(x))),
  });

  it("covers both valid and deliberately broken probes", () => {
    expect(PROBES.length).toBeGreaterThan(90);
    expect(PROBES.some((p) => !p.wantErr)).toBe(true);
  });

  it.each(PROBES.map((p) => [p.file, p] as const))("%s", (_file, p) => {
    const { root, leaf, proof } = decode(p);
    expect(verifyInclusion(p.leafIdx, p.treeSize, leaf, proof, root)).toBe(!p.wantErr);
  });

  it("every leaf of every reference tree proves against the reference root", () => {
    for (let size = 1; size <= LEAF_INPUTS.length; size++) {
      const tree = new MerkleTree(LEAF_INPUTS.slice(0, size));
      for (let i = 0; i < size; i++) {
        expect(verifyInclusion(i, size, tree.leafHashes[i]!, tree.proof(i), fromHex(ROOTS_BY_SIZE[size]!))).toBe(true);
      }
    }
  });
});

describe("inclusion proofs (property tests)", () => {
  const random = rng(42);
  const randomLeaves = (n: number) =>
    Array.from({ length: n }, () => Buffer.from(Array.from({ length: 1 + Math.floor(random() * 40) }, () => Math.floor(random() * 256))));

  it("every leaf verifies, for every tree size from 1 to 70", () => {
    for (let n = 1; n <= 70; n++) {
      const tree = new MerkleTree(randomLeaves(n));
      for (let i = 0; i < n; i++) {
        expect(verifyInclusion(i, n, tree.leafHashes[i]!, tree.proof(i), tree.root)).toBe(true);
      }
    }
  });

  it("any wrong leaf, index, size, sibling or root fails", () => {
    for (let n = 2; n <= 40; n++) {
      const tree = new MerkleTree(randomLeaves(n));
      const i = Math.floor(random() * n);
      const leaf = tree.leafHashes[i]!;
      const proof = tree.proof(i);
      const flip = (h: Buffer, byte = 0) => {
        const c = Buffer.from(h);
        c[byte] = c[byte]! ^ 0x01;
        return c;
      };
      expect(verifyInclusion(i, n, flip(leaf), proof, tree.root)).toBe(false);
      expect(verifyInclusion((i + 1) % n, n, leaf, proof, tree.root)).toBe(false);
      expect(verifyInclusion(i, n, leaf, proof, flip(tree.root, 31))).toBe(false);
      expect(verifyInclusion(i, n, leaf, proof.slice(0, -1), tree.root)).toBe(false);
      expect(verifyInclusion(i, n, leaf, [...proof, proof[0]!], tree.root)).toBe(false);
      const s = Math.floor(random() * proof.length);
      expect(verifyInclusion(i, n, leaf, proof.map((p, j) => (j === s ? flip(p, 7) : p)), tree.root)).toBe(false);
      // Tree size is not committed by the root alone; attestations sign leaf_count (tested in TQ.2).
    }
  });

  it("an interior node cannot be passed off as a leaf", () => {
    const tree = new MerkleTree(["a", "b", "c", "d"]);
    const interior = nodeHash(tree.leafHashes[0]!, tree.leafHashes[1]!);
    // Pretend the 2-leaf subtree root is leaf 0 of a 2-leaf tree with the same root.
    const fakeProof = [nodeHash(tree.leafHashes[2]!, tree.leafHashes[3]!)];
    expect(verifyInclusion(0, 2, interior, fakeProof, tree.root)).toBe(true); // structurally valid…
    // …but a leaf hash is always SHA-256(0x00 || data), so no leaf data can produce `interior`
    // unless SHA-256 is broken. The verifier of a receipt hashes leaf data itself (TQ.8).
    expect(toHex(leafHash(Buffer.concat([tree.leafHashes[0]!, tree.leafHashes[1]!])))).not.toBe(toHex(interior));
  });

  it("rejects malformed input without throwing", () => {
    const tree = new MerkleTree(["a", "b", "c"]);
    expect(verifyInclusion(-1, 3, tree.leafHashes[0]!, tree.proof(0), tree.root)).toBe(false);
    expect(verifyInclusion(0.5, 3, tree.leafHashes[0]!, tree.proof(0), tree.root)).toBe(false);
    expect(verifyInclusion(0, 3, Buffer.alloc(31), tree.proof(0), tree.root)).toBe(false);
    expect(verifyInclusion(3, 3, tree.leafHashes[0]!, tree.proof(0), tree.root)).toBe(false);
    expect(() => inclusionProof(tree.leafHashes, 3)).toThrow(RangeError);
    expect(() => fromHex("zz")).toThrow(TypeError);
  });
});
