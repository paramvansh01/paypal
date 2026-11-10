import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HEX64 } from "../qaps/protocol.js";

/**
 * Content-addressed artifact store. Every file is saved under its own SHA-256,
 * so the hash a verifier signs in its Merkle leaf is also the file's address:
 * anyone who downloads `/evidence/<hash>.png` can check it is exactly what was
 * signed. Writing the same bytes twice is a no-op.
 */

export type ArtifactKind = "png" | "json";

export interface StoredArtifact {
  sha256: string;
  kind: ArtifactKind;
  bytes: number;
}

export class EvidenceStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  put(data: Buffer | string, kind: ArtifactKind): StoredArtifact {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const file = this.pathFor(sha256, kind);
    if (!existsSync(file)) {
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, buf);
      renameSync(tmp, file); // atomic: readers never see a half-written file
    }
    return { sha256, kind, bytes: buf.length };
  }

  /** Returns the bytes only if they still hash to their name. */
  get(sha256: string, kind: ArtifactKind): Buffer | undefined {
    if (!HEX64.test(sha256)) return undefined;
    const file = this.pathFor(sha256, kind);
    if (!existsSync(file)) return undefined;
    const buf = readFileSync(file);
    return createHash("sha256").update(buf).digest("hex") === sha256 ? buf : undefined;
  }

  pathFor(sha256: string, kind: ArtifactKind): string {
    if (!HEX64.test(sha256)) throw new Error("invalid artifact hash");
    return join(this.dir, `${sha256}.${kind}`);
  }
}
