import { z } from "zod";
import { canonicalJson } from "../core/checklist.js";
import { CHECK_TYPES } from "../db/schema.js";
import { MerkleTree, toHex } from "./merkle.js";
import { HEX64 } from "./protocol.js";

/**
 * One verifier's result for one checklist item. Leaves are hashed in contract
 * order into the verifier's Merkle tree (section 6.11). Large artifacts such as
 * screenshots are committed by their SHA-256, not embedded.
 */
export const VOTES = ["pass", "fail", "needs_client", "error"] as const;
export type Vote = (typeof VOTES)[number];

export const LeafRecord = z.strictObject({
  m: z.number().int().min(0),
  i: z.number().int().min(0),
  check_type: z.enum(CHECK_TYPES),
  verdict: z.enum(VOTES),
  /** True when the tripwire or the judge canary caught an injection attempt. */
  injection: z.boolean(),
  measured_value: z.string().max(2000).nullable(),
  summary: z.string().max(2000),
  /** Artifact name → SHA-256 hex of its bytes (e.g. screenshot_sha256). */
  artifacts: z.record(z.string().regex(/^[a-z0-9_]{1,64}$/), z.string().regex(HEX64)),
});
export type LeafRecord = z.infer<typeof LeafRecord>;

export function leafBytes(leaf: LeafRecord): Buffer {
  return Buffer.from(canonicalJson(leaf), "utf8");
}

export function evidenceTree(leaves: readonly LeafRecord[]): MerkleTree {
  return new MerkleTree(leaves.map(leafBytes));
}

export function evidenceRoot(leaves: readonly LeafRecord[]): string {
  return toHex(evidenceTree(leaves).root);
}
