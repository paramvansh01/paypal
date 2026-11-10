import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { HEX64 } from "../src/qaps/protocol.js";
import { verifyReceipt, type ReceiptCheck } from "../src/qaps/receipt.js";

/**
 * npm run verify-receipt -- <receipt.json | receipt URL> [--issuer <sha256>] [--artifacts | --no-artifacts]
 *
 * Kept's own verifier (src/qaps/receipt.ts). tools/verify-receipt.mjs is a
 * separate zero-dependency implementation of the same checks for people who
 * do not want to install anything; the tests require both to agree.
 */

const args = process.argv.slice(2);
const take = (name: string, withValue = false): string | true | undefined => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = withValue ? args[i + 1] : true;
  args.splice(i, withValue ? 2 : 1);
  return v;
};
const noArtifacts = take("--no-artifacts");
const wantArtifacts = take("--artifacts");
let issuer = take("--issuer", true) as string | undefined;
const source = args[0];
if (!source || args.length > 1 || (issuer !== undefined && !HEX64.test(issuer))) {
  console.error("usage: npm run verify-receipt -- <receipt.json | receipt URL> [--issuer <sha256>] [--artifacts | --no-artifacts]");
  process.exit(2);
}

const isUrl = /^https?:\/\//i.test(source);
let receipt: { artifacts?: { sha256: string; kind: string; url: string }[]; job?: { id?: string }; contract_hash?: string; paypal?: { order_id?: string | null } };
try {
  receipt = isUrl ? await (await fetch(source)).json() : JSON.parse(readFileSync(source, "utf8"));
} catch (err) {
  console.error(`could not read ${source}: ${(err as Error).message}`);
  process.exit(1);
}
let issuerSource = issuer ? "--issuer" : undefined;
if (!issuer && isUrl) {
  const url = new URL("/.well-known/kept/issuer.json", source);
  const pub = (await fetch(url).then((r) => r.json()).catch(() => null)) as { issuer?: { fingerprint?: string } } | null;
  if (pub?.issuer?.fingerprint && HEX64.test(pub.issuer.fingerprint)) [issuer, issuerSource] = [pub.issuer.fingerprint, url.href];
}

const result = verifyReceipt(receipt, { issuerFingerprint: issuer });
const checks: ReceiptCheck[] = [...result.checks];
if ((isUrl && !noArtifacts) || wantArtifacts) {
  const bad: string[] = [];
  for (const a of receipt.artifacts ?? []) {
    const res = await fetch(a.url).catch((e: Error) => e);
    if (res instanceof Error || !res.ok) {
      bad.push(`${a.sha256}.${a.kind}: ${res instanceof Error ? res.message : `HTTP ${res.status}`}`);
      continue;
    }
    const got = createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex");
    if (got !== a.sha256) bad.push(`${a.sha256}.${a.kind}: content hashes to ${got}`);
  }
  const n = receipt.artifacts?.length ?? 0;
  checks.push({ check: "artifact_bytes", ok: bad.length === 0, detail: bad.length ? `${bad.length} of ${n} failed: ${bad.slice(0, 3).join("; ")}` : `downloaded ${n} artifacts, every one hashes to its name` });
}

const ok = checks.every((c) => c.ok);
console.log(`Kept Proof Receipt — ${receipt?.job?.id ?? "?"} (${source})\n`);
for (const c of checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.check.padEnd(17)} ${c.detail}`);
console.log("");
console.log(issuerSource ? `  note  issuer key compared with ${issuerSource}` : "  note  issuer key not checked: pass --issuer <fingerprint> from the Kept server's /.well-known/kept/issuer.json");
if (typeof receipt?.contract_hash === "string") console.log(`  note  in PayPal, order ${receipt.paypal?.order_id ?? "?"} should carry custom_id = ${receipt.contract_hash}`);
console.log(`\n${ok ? "VALID: every check passed" : `INVALID: ${checks.filter((c) => !c.ok).length} check(s) failed`}`);
process.exit(ok ? 0 : 1);
