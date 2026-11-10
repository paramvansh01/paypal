#!/usr/bin/env node
// Kept Proof Receipt verifier — standalone, zero dependencies (plain Node 20+).
//
//   node verify-receipt.mjs <receipt.json | https://…/jobs/<id>/receipt> [options]
//
// Options:
//   --issuer <sha256>   expected fingerprint of Kept's receipt-sealing key
//   --artifacts         download every artifact and check its SHA-256 (default for URLs)
//   --no-artifacts      skip artifact downloads
//   --json              print the result as JSON
//
// It recomputes the contract hash, every verifier signature, every Merkle root,
// the quorum verdicts, the milestone outcomes and the issuer seal, and prints a
// pass/fail line per check. Exit code 0 = valid, 1 = invalid, 2 = usage error.
//
// This file is deliberately independent of the Kept codebase: a second,
// separate implementation of the protocol (docs/PROTOCOL.md, CLAUDE.md 6.9–6.12).

import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PROTOCOL = "kept-qaps/1";
const HEX64 = /^[0-9a-f]{64}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const VOTES = ["pass", "fail", "needs_client", "error"];

// ---------- primitives ----------

/** Canonical JSON: keys sorted by UTF-16 code unit, no whitespace (RFC 8785 for our data). */
export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new TypeError(`unsupported type ${typeof value}`);
}

const sha256 = (...parts) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};
const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const canonicalHash = (v) => sha256Hex(canonicalJson(v));

/** RFC 6962 Merkle tree hash over leaf byte strings. */
export function merkleRoot(leafBytes) {
  const leafHashes = leafBytes.map((b) => sha256(Buffer.from([0]), b));
  const root = (hs) => {
    if (hs.length === 0) return sha256();
    if (hs.length === 1) return hs[0];
    let k = 1;
    while (k * 2 < hs.length) k *= 2;
    return sha256(Buffer.from([1]), root(hs.slice(0, k)), root(hs.slice(k)));
  };
  return root(leafHashes).toString("hex");
}

const fingerprintOf = (publicKeyB64url) => createHash("sha256").update(Buffer.from(publicKeyB64url, "base64url")).digest("hex");

function ed25519Verify(publicKeyB64url, message, signatureB64url) {
  try {
    if (typeof publicKeyB64url !== "string" || typeof signatureB64url !== "string") return false;
    if (!B64URL.test(publicKeyB64url) || !B64URL.test(signatureB64url)) return false;
    const sig = Buffer.from(signatureB64url, "base64url");
    const raw = Buffer.from(publicKeyB64url, "base64url");
    if (sig.length !== 64 || raw.length !== 32) return false;
    // Only the canonical encoding: otherwise unused trailing bits give one signature many spellings.
    if (sig.toString("base64url") !== signatureB64url || raw.toString("base64url") !== publicKeyB64url) return false;
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKeyB64url }, format: "jwk" });
    return verify(null, Buffer.from(message, "utf8"), key, sig);
  } catch {
    return false;
  }
}

// ---------- shape checks (small, strict) ----------

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v) => Number.isSafeInteger(v);
const isNat = (v) => isInt(v) && v >= 0;
const isStr = (v) => typeof v === "string";
const isHex = (v) => isStr(v) && HEX64.test(v);
const isIso = (v) => isStr(v) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) && !Number.isNaN(Date.parse(v));
const isUrl = (v) => {
  try {
    return isStr(v) && Boolean(new URL(v));
  } catch {
    return false;
  }
};

/** Checks `obj` has exactly these keys and each passes its test. Returns the first problem or null. */
function shape(obj, spec, path) {
  if (!isObj(obj)) return `${path} is not an object`;
  for (const k of Object.keys(obj)) if (!(k in spec)) return `${path}.${k} is not allowed`;
  for (const [k, test] of Object.entries(spec)) {
    if (!(k in obj)) return `${path}.${k} is missing`;
    const r = test(obj[k], `${path}.${k}`);
    if (r === false) return `${path}.${k} has the wrong type`;
    if (typeof r === "string") return r;
  }
  return null;
}
const nullable = (t) => (v, p) => (v === null ? true : t(v, p));
const arrayOf = (t) => (v, p) => {
  if (!Array.isArray(v)) return false;
  for (const [i, x] of v.entries()) {
    const r = t(x, `${p}[${i}]`);
    if (r === false) return `${p}[${i}] has the wrong type`;
    if (typeof r === "string") return r;
  }
  return true;
};
const recordOf = (t) => (v, p) => {
  if (!isObj(v)) return false;
  for (const [k, x] of Object.entries(v)) {
    const r = t(x, `${p}.${k}`);
    if (r === false) return `${p}.${k} has the wrong type`;
    if (typeof r === "string") return r;
  }
  return true;
};
const oneOf = (...vals) => (v) => vals.includes(v);
const sub = (spec) => (v, p) => shape(v, spec, p) ?? true;
const any = () => true;

const receiptSpec = {
  v: oneOf(PROTOCOL),
  type: oneOf("proof_receipt"),
  job: sub({ id: (v) => isStr(v) && v.length > 0, title: isStr, status: isStr, rail: isStr, deliverable_url: isStr }),
  contract: any,
  contract_hash: isHex,
  certificate: any,
  certificate_hash: isHex,
  leaves: recordOf((v) => Array.isArray(v)),
  artifacts: arrayOf(sub({ sha256: isHex, kind: oneOf("png", "json"), url: isStr })),
  client_decisions: arrayOf(sub({ m: isNat, i: isNat, decision: oneOf("approve", "reject"), actor: isStr, note: nullable(isStr), decided_at: isStr })),
  milestones: arrayOf(
    sub({
      m: isNat,
      title: isStr,
      amount_cents: isInt,
      outcome: oneOf("passed", "failed", "pending"),
      status: isStr,
      paypal: sub({ capture_id: nullable(isStr), release_id: nullable(isStr), refund_id: nullable(isStr) }),
    }),
  ),
  paypal: sub({ order_id: nullable(isStr), contract_hash_field: oneOf("purchase_units[].custom_id") }),
  events: arrayOf(sub({ type: isStr, actor: isStr, payload: nullable(isObj), at: isStr })),
  issued_at: isIso,
  seal: sub({
    v: oneOf(PROTOCOL),
    type: oneOf("receipt_seal"),
    issuer: (v) => isStr(v) && v.length > 0,
    public_key: isStr,
    key_fingerprint: isHex,
    sections: recordOf(isHex),
    signature: isStr,
  }),
};

const leafSpec = {
  m: isNat,
  i: isNat,
  check_type: isStr,
  verdict: oneOf(...VOTES),
  injection: (v) => typeof v === "boolean",
  measured_value: nullable(isStr),
  summary: isStr,
  artifacts: recordOf(isHex),
};

const attestationSpec = {
  payload: sub({
    v: oneOf(PROTOCOL),
    type: oneOf("attestation"),
    job_id: isStr,
    contract_hash: isHex,
    deliverable_url: isUrl,
    verifier_id: isStr,
    browser: isStr,
    judge_model: isStr,
    merkle_root: isHex,
    leaf_count: isNat,
    issued_at: isIso,
  }),
  signature: isStr,
  key_fingerprint: isHex,
};

const certificateSpec = {
  v: oneOf(PROTOCOL),
  type: oneOf("quorum_certificate"),
  job_id: isStr,
  contract_hash: isHex,
  deliverable_url: isUrl,
  k: (v) => isInt(v) && v >= 1,
  n: (v) => isInt(v) && v >= 1,
  attestations: (v, p) => (Array.isArray(v) && v.length >= 1 ? arrayOf(sub(attestationSpec))(v, p) : false),
  items: arrayOf(sub({ m: isNat, i: isNat, verdict: oneOf("pass", "fail", "needs_client"), reason: oneOf("quorum", "no_quorum", "injection", "client") })),
  issued_at: isIso,
};

function contractProblem(c) {
  if (!isObj(c) || !Array.isArray(c.milestones) || !isObj(c.quorum)) return "contract is malformed";
  const q = c.quorum;
  if (!isInt(q.n) || !isInt(q.k) || !Array.isArray(q.verifiers)) return "contract is malformed";
  for (const v of q.verifiers) if (!isObj(v) || !isStr(v.id) || !isStr(v.public_key)) return "contract is malformed";
  for (const ms of c.milestones) {
    if (!isObj(ms) || !isStr(ms.title) || !isInt(ms.amount_cents) || !Array.isArray(ms.items)) return "contract is malformed";
    for (const it of ms.items) if (!isObj(it) || !isStr(it.check_type)) return "contract is malformed";
  }
  return null;
}

// ---------- the quorum rule (CLAUDE.md 6.9) ----------

export function decideItem(checkType, ballots, k) {
  if (checkType === "client_approval") return { verdict: "needs_client", reason: "client" };
  const injections = ballots.filter((b) => b.injection).length;
  if (injections >= k) return { verdict: "fail", reason: "injection" };
  const pass = ballots.filter((b) => b.verdict === "pass" && !b.injection).length;
  const fail = ballots.filter((b) => b.verdict === "fail" || b.injection).length;
  if (pass >= k) return { verdict: "pass", reason: "quorum" };
  if (fail >= k) return { verdict: "fail", reason: "quorum" };
  return { verdict: "needs_client", reason: "no_quorum" };
}

const contractItems = (c) => c.milestones.flatMap((ms, m) => ms.items.map((item, i) => ({ m, i, item })));

function milestoneOutcomes(contract, items, decisions) {
  return contract.milestones.map((ms, m) => {
    let pending = false;
    for (let i = 0; i < ms.items.length; i++) {
      let verdict = items.find((x) => x.m === m && x.i === i)?.verdict;
      if (verdict === "needs_client") {
        const d = decisions.find((x) => x.m === m && x.i === i);
        verdict = d ? (d.decision === "approve" ? "pass" : "fail") : undefined;
      }
      if (verdict === "fail") return "failed";
      if (verdict !== "pass") pending = true;
    }
    return pending ? "pending" : "passed";
  });
}

function checkReport(att, leaves, contract, expected) {
  const p = att.payload;
  const who = p.verifier_id;
  const key = contract.quorum.verifiers.find((v) => v.id === who);
  if (!key) return `unknown verifier ${who}`;
  if (fingerprintOf(key.public_key) !== att.key_fingerprint) return `key fingerprint does not match the contract's key for ${who}`;
  if (!ed25519Verify(key.public_key, canonicalJson(p), att.signature)) return `signature by ${who} does not verify`;
  if (p.job_id !== expected.job_id) return `${who} attested a different job (${p.job_id})`;
  if (p.contract_hash !== expected.contract_hash) return `${who} attested a different contract`;
  if (p.deliverable_url !== expected.deliverable_url) return `${who} attested a different deliverable URL`;
  const items = contractItems(contract);
  if (!Array.isArray(leaves)) return `${who}: leaves missing`;
  if (leaves.length !== items.length) return `${who}: ${leaves.length} leaves for ${items.length} contract items`;
  if (p.leaf_count !== leaves.length) return `${who}: signed leaf_count ${p.leaf_count} ≠ ${leaves.length} leaves`;
  for (const [idx, { m, i, item }] of items.entries()) {
    const l = leaves[idx];
    if (l.m !== m || l.i !== i) return `${who}: leaf ${idx} is for item ${l.m}.${l.i}, expected ${m}.${i}`;
    if (l.check_type !== item.check_type) return `${who}: leaf ${idx} has check type ${l.check_type}, contract says ${item.check_type}`;
  }
  const root = merkleRoot(leaves.map((l) => Buffer.from(canonicalJson(l), "utf8")));
  if (root !== p.merkle_root) return `${who}: evidence does not match the signed Merkle root`;
  return null;
}

// ---------- the receipt ----------

/**
 * Verifies a receipt object. Never throws. Returns { ok, checks: [{ check, ok, detail }] }
 * with the same check names as Kept's own verifier (src/qaps/receipt.ts).
 */
export function verifyReceipt(r, opts = {}) {
  const checks = [];
  const add = (check, ok, detail) => checks.push({ check, ok, detail });
  const done = () => ({ ok: checks.length > 0 && checks.every((c) => c.ok), checks });
  try {
    const bad = shape(r, receiptSpec, "receipt");
    if (bad) {
      add("format", false, `receipt is malformed: ${bad}`);
      return done();
    }
    add("format", true, "receipt has the kept-qaps/1 proof_receipt shape");

    // Seal: covers every section, including Kept's own records.
    const { seal } = r;
    const sections = Object.fromEntries(
      Object.keys(r)
        .filter((k) => k !== "seal")
        .sort()
        .map((k) => [k, canonicalHash(r[k])]),
    );
    const changed = [...new Set([...Object.keys(sections), ...Object.keys(seal.sections)])].sort().filter((k) => sections[k] !== seal.sections[k]);
    add("seal_sections", changed.length === 0, changed.length ? `changed since sealing: ${changed.join(", ")}` : "every section matches the sealed hashes");
    const { signature, ...unsigned } = seal;
    const sigOk = fingerprintOf(seal.public_key) === seal.key_fingerprint && ed25519Verify(seal.public_key, canonicalJson(unsigned), signature);
    add("seal_signature", sigOk, sigOk ? `sealed by ${seal.issuer}, key ${seal.key_fingerprint}` : "seal signature does not verify");
    if (opts.issuerFingerprint !== undefined) {
      const ok = opts.issuerFingerprint === seal.key_fingerprint;
      add("issuer_key", ok, ok ? "issuer key matches the published Kept key" : `issuer key ${seal.key_fingerprint} is not the published Kept key ${opts.issuerFingerprint}`);
    }

    const contract = r.contract;
    const cp = contractProblem(contract);
    if (cp) {
      add("contract", false, cp);
      return done();
    }
    const recomputed = canonicalHash(contract);
    add(
      "contract_hash",
      recomputed === r.contract_hash,
      recomputed === r.contract_hash ? `contract hashes to ${recomputed}` : `contract hashes to ${recomputed}, receipt says ${r.contract_hash}`,
    );

    for (const [id, list] of Object.entries(r.leaves)) {
      for (const [idx, l] of list.entries()) {
        if (shape(l, leafSpec, "leaf")) {
          add("leaves", false, `${id}: leaf ${idx} is malformed`);
          return done();
        }
      }
    }

    // Certificate, validated from scratch against the contract.
    const certFail = (reason) => {
      add("certificate", false, reason);
      return done();
    };
    const cert = r.certificate;
    const certBad = shape(cert, certificateSpec, "certificate");
    if (certBad) return certFail(`certificate is malformed: ${certBad}`);
    const expected = { job_id: r.job.id, contract_hash: r.contract_hash, deliverable_url: r.job.deliverable_url };
    if (recomputed !== expected.contract_hash) return certFail("contract does not match the agreed contract hash");
    if (cert.contract_hash !== recomputed) return certFail("certificate is for a different contract");
    if (cert.job_id !== expected.job_id) return certFail("certificate is for a different job");
    if (cert.deliverable_url !== expected.deliverable_url) return certFail("certificate is for a different deliverable URL");
    const { k, n } = contract.quorum;
    if (cert.k !== k || cert.n !== n) return certFail(`certificate claims ${cert.k}-of-${cert.n}, contract requires ${k}-of-${n}`);
    const seen = new Set();
    const reports = [];
    for (const att of cert.attestations) {
      const id = att.payload.verifier_id;
      if (seen.has(id)) return certFail(`duplicate attestation from ${id}`);
      seen.add(id);
      const problem = checkReport(att, r.leaves[id] ?? [], contract, expected);
      if (problem) return certFail(problem);
      reports.push(r.leaves[id]);
    }
    if (reports.length < k) return certFail(`only ${reports.length} attestations, ${k} required`);
    const decided = contractItems(contract).map(({ m, i, item }, idx) => ({
      m,
      i,
      ...decideItem(
        item.check_type,
        reports.map((leaves) => ({ verdict: leaves[idx].verdict, injection: leaves[idx].injection })),
        k,
      ),
    }));
    if (canonicalJson(decided) !== canonicalJson(cert.items)) return certFail("certificate verdicts do not follow from the attested evidence");
    add("certificate", true, "signatures, Merkle roots and quorum verdicts all check out");

    const certHash = canonicalHash(cert);
    add(
      "certificate_hash",
      certHash === r.certificate_hash,
      certHash === r.certificate_hash ? `certificate hashes to ${certHash}` : `certificate hashes to ${certHash}, receipt says ${r.certificate_hash}`,
    );

    const extra = Object.keys(r.leaves).filter((id) => !seen.has(id));
    add("leaves", extra.length === 0, extra.length ? `leaves from verifiers that did not attest: ${extra.join(", ")}` : "leaves only from attesting verifiers");

    const kindOf = (name) => (name.startsWith("screenshot") ? "png" : "json");
    const committed = new Set();
    for (const id of Object.keys(r.leaves)) for (const l of r.leaves[id]) for (const [name, h] of Object.entries(l.artifacts)) committed.add(`${h}.${kindOf(name)}`);
    const listed = new Set(r.artifacts.map((a) => `${a.sha256}.${a.kind}`));
    const sameSet = committed.size === listed.size && listed.size === r.artifacts.length && [...committed].every((x) => listed.has(x));
    const urlsOk = r.artifacts.every((a) => a.url.endsWith(`/evidence/${a.sha256}.${a.kind}`));
    add(
      "artifacts",
      sameSet && urlsOk,
      !sameSet
        ? "artifact index does not match the hashes committed in the leaves"
        : urlsOk
          ? `${r.artifacts.length} artifacts, each addressed by its SHA-256`
          : "an artifact URL does not end in /evidence/<sha256>.<kind>",
    );

    const seenDecision = new Set();
    let decOk = true;
    let decDetail = `${r.client_decisions.length} client decision(s), each on an item left to the client`;
    for (const d of r.client_decisions) {
      const key = `${d.m}.${d.i}`;
      const item = decided.find((x) => x.m === d.m && x.i === d.i);
      if (seenDecision.has(key)) [decOk, decDetail] = [false, `two decisions for item ${key}`];
      else if (!item) [decOk, decDetail] = [false, `decision for unknown item ${key}`];
      else if (item.verdict !== "needs_client") [decOk, decDetail] = [false, `item ${key} was decided by the quorum (${item.verdict}), not the client`];
      seenDecision.add(key);
    }
    add("client_decisions", decOk, decDetail);

    const outcomes = milestoneOutcomes(contract, decided, r.client_decisions);
    let msOk = r.milestones.length === contract.milestones.length;
    let msDetail = msOk ? "every milestone outcome follows from the verdicts" : `${r.milestones.length} milestones, contract has ${contract.milestones.length}`;
    if (msOk) {
      for (const [m, ms] of r.milestones.entries()) {
        const c = contract.milestones[m];
        if (ms.m !== m || ms.title !== c.title || ms.amount_cents !== c.amount_cents) {
          [msOk, msDetail] = [false, `milestone ${m} does not match the contract`];
          break;
        }
        if (ms.outcome !== outcomes[m]) {
          [msOk, msDetail] = [false, `milestone ${m} says ${ms.outcome}, the verdicts say ${outcomes[m]}`];
          break;
        }
        if ((ms.status === "released" && ms.outcome !== "passed") || (ms.status === "refunded" && ms.outcome !== "failed")) {
          [msOk, msDetail] = [false, `milestone ${m} was ${ms.status} but its outcome is ${ms.outcome}`];
          break;
        }
      }
    }
    add("milestones", msOk, msDetail);
    return done();
  } catch (err) {
    add("format", false, `could not be checked: ${err?.message ?? err}`);
    return done();
  }
}

/** Downloads every artifact and checks it hashes to its name. */
export async function verifyArtifacts(receipt, fetchImpl = fetch) {
  const bad = [];
  for (const a of receipt.artifacts ?? []) {
    try {
      const res = await fetchImpl(a.url);
      if (!res.ok) {
        bad.push(`${a.sha256}.${a.kind}: HTTP ${res.status}`);
        continue;
      }
      const got = createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex");
      if (got !== a.sha256) bad.push(`${a.sha256}.${a.kind}: content hashes to ${got}`);
    } catch (err) {
      bad.push(`${a.sha256}.${a.kind}: ${err?.message ?? err}`);
    }
  }
  const n = receipt.artifacts?.length ?? 0;
  return { check: "artifact_bytes", ok: bad.length === 0, detail: bad.length ? `${bad.length} of ${n} failed: ${bad.slice(0, 3).join("; ")}` : `downloaded ${n} artifacts, every one hashes to its name` };
}

// ---------- CLI ----------

async function main(argv) {
  const args = argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    args.splice(i, 1);
    return true;
  };
  const option = (name) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const asJson = flag("--json");
  const noArtifacts = flag("--no-artifacts");
  const wantArtifacts = flag("--artifacts");
  let issuerFingerprint = option("--issuer");
  const source = args[0];
  if (!source || args.length > 1 || (issuerFingerprint !== undefined && !HEX64.test(issuerFingerprint))) {
    console.error("usage: node verify-receipt.mjs <receipt.json | receipt URL> [--issuer <sha256>] [--artifacts | --no-artifacts] [--json]");
    return 2;
  }

  const isUrlSource = /^https?:\/\//i.test(source);
  let receipt;
  try {
    receipt = isUrlSource ? await (await fetch(source)).json() : JSON.parse(readFileSync(source, "utf8"));
  } catch (err) {
    console.error(`could not read ${source}: ${err?.message ?? err}`);
    return 1;
  }
  let issuerSource = issuerFingerprint ? "--issuer" : undefined;
  if (!issuerFingerprint && isUrlSource) {
    try {
      const url = new URL("/.well-known/kept/issuer.json", source);
      const pub = await (await fetch(url)).json();
      if (HEX64.test(pub?.issuer?.fingerprint ?? "")) [issuerFingerprint, issuerSource] = [pub.issuer.fingerprint, url.href];
    } catch {
      /* reported below as "not checked" */
    }
  }

  const result = verifyReceipt(receipt, { issuerFingerprint });
  if ((isUrlSource && !noArtifacts) || wantArtifacts) {
    const a = await verifyArtifacts(receipt);
    result.checks.push(a);
    result.ok = result.ok && a.ok;
  }

  if (asJson) {
    console.log(JSON.stringify({ ...result, issuer_key_source: issuerSource ?? null }, null, 2));
    return result.ok ? 0 : 1;
  }
  console.log(`Kept Proof Receipt — ${receipt?.job?.id ?? "?"} (${source})\n`);
  for (const c of result.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.check.padEnd(17)} ${c.detail}`);
  console.log("");
  if (!issuerSource) console.log("  note  issuer key not checked: pass --issuer <fingerprint> from the Kept server's /.well-known/kept/issuer.json");
  else console.log(`  note  issuer key compared with ${issuerSource}`);
  if (typeof receipt?.contract_hash === "string") {
    console.log(`  note  in PayPal, order ${receipt?.paypal?.order_id ?? "?"} should carry custom_id = ${receipt.contract_hash}`);
  }
  console.log(`\n${result.ok ? "VALID" : "INVALID"}: ${result.ok ? "every check passed" : `${result.checks.filter((c) => !c.ok).length} check(s) failed`}`);
  return result.ok ? 0 : 1;
}

const isMain = () => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isMain()) {
  main(process.argv).then((code) => process.exit(code));
}
