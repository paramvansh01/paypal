# Kept Protocol v1 (`kept-qaps/1`)

**Proof-Carrying Payments with Quorum-Attested Proof Settlement (QAPS)**

Status: draft, implemented in this repository. Every rule here maps to code, listed in [§11](#11-reference-implementation). The test vectors in [`protocol-vectors.json`](protocol-vectors.json) are generated from that code, and a test fails if they drift ([§10](#10-test-vectors)).

The words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Sections marked *(informative)* explain; everything else is normative.

---

## 1. Overview *(informative)*

A Proof-Carrying Payment is money held on a payment rail (PayPal) together with a machine-checkable contract that decides when it moves.

```
client + worker ──agree──▶ contract ──SHA-256──▶ contract_hash ──▶ PayPal order custom_id
                                │
        worker delivers a URL   ▼
   n verifiers ──each──▶ leaves ──RFC 6962──▶ Merkle root ──Ed25519──▶ attestation
                                                                        │
                       k-of-n quorum rule over the attested leaves ◀────┘
                                │
                                ▼
                       quorum certificate ──▶ settlement (release / refund per milestone)
                                │
                                ▼
                       Proof Receipt (sealed) ──▶ anyone verifies offline
```

Parties:

| Role | Does |
| --- | --- |
| **Client** | Pays. Agrees the contract, funds it, decides items left to a person. |
| **Worker** | Delivers. Agrees the contract, submits the deliverable URL. |
| **Verifier** | Checks the deliverable against the contract and signs what it saw. Identified by an ID and an Ed25519 key listed in the contract. |
| **Settler** | Validates the certificate from scratch and moves money on the rail. In this implementation, the Kept server. |
| **Issuer** | Assembles and seals the Proof Receipt. In this implementation, the Kept server (`kept-issuer` key). |

Trust anchors:

1. **The contract hash.** Both parties accept it and it is written onto the PayPal order. It fixes the checks, the amounts, *and* the verifier panel (k, n and every verifier key). Nobody can swap a verifier or lower k after funding.
2. **Verifier keys** (from the contract). Signatures prove which verifier key attested which evidence.
3. **The issuer key** (published by the Kept server). It covers only the receipt's bookkeeping sections (PayPal IDs, events, status), not the proof.

---

## 2. Encodings

### 2.1 Canonical JSON

All hashed or signed objects are serialised as canonical JSON:

- Object keys sorted by UTF-16 code unit (JavaScript's default string order), with members whose value is `undefined` omitted.
- Arrays keep their order.
- No insignificant whitespace.
- Strings and numbers written as `JSON.stringify` writes them. Protocol objects use only strings, integers, booleans, `null`, arrays and objects; non-finite numbers MUST be rejected.

For this data the output equals RFC 8785 (JCS). Example (vector `canonical_json`):

```
input:  {"b":[3,1,{"z":true,"a":null}],"a":"é \"quoted\"","A":-7,"_":{"y":1,"x":2}}
output: {"A":-7,"_":{"x":2,"y":1},"a":"é \"quoted\"","b":[3,1,{"a":null,"z":true}]}
```

Hashes are computed over the UTF-8 bytes of the canonical JSON.

### 2.2 Other encodings

| Thing | Encoding |
| --- | --- |
| Hash | SHA-256, 64 lowercase hex characters |
| Public key | Raw 32-byte Ed25519 key, base64url without padding (43 characters) |
| Signature | Ed25519 (RFC 8032, pure, no prehash), 64 bytes, base64url without padding (86 characters) |
| Key fingerprint | SHA-256 of the raw 32-byte public key, hex |
| Timestamp | ISO 8601 UTC, e.g. `2026-11-10T12:00:00.000Z` |
| Protocol tag | `"v": "kept-qaps/1"` on every signed object |

**Canonical base64url only.** A decoder MUST reject a signature or key whose re-encoding differs from the input. The last character of an 86-character signature carries 4 unused bits, so lenient decoders accept several spellings of one signature. Kept's tests found this; see the Decision Log.

---

## 3. The contract

### 3.1 Format

```json
{
  "version": 1,
  "currency": "USD",
  "total_cents": 5000,
  "milestones": [
    { "title": "Page live", "amount_cents": 3000, "items": [
      { "description": "Loads", "check_type": "http_status", "params": { "path": "/", "expected": 200 } }
    ] }
  ],
  "quorum": { "n": 3, "k": 2, "verifiers": [ { "id": "verifier-a", "public_key": "<43 chars>" } ] }
}
```

| Field | Rule |
| --- | --- |
| `version` | `1` |
| `currency` | ISO 4217, three capital letters |
| `total_cents` | positive integer; MUST equal the sum of `milestones[].amount_cents` |
| `milestones` | 1–10, in order. Each: `title` (1–200 chars), `amount_cents` (positive integer), `items` (1–20) |
| `items[]` | `description` (1–500 chars), `check_type`, `params` (per type, below). No other keys. |
| `quorum.n` | 1–7, and equal to the number of `verifiers` |
| `quorum.k` | `n/2 < k ≤ n` (more than half; this is what makes two opposite quorums impossible) |
| `quorum.verifiers[]` | `id` matching `^[a-z0-9-]{1,64}$`, unique; `public_key` unique |

Every object is strict: unknown keys MUST be rejected.

Items are addressed by **(m, i)**: the milestone index and the item index within it, both zero-based. "Contract order" means milestones in order, and items in order within each milestone.

### 3.2 Check types

`path` is in every `params` (default `"/"`). It MUST start with `/`. See [§4.1](#41-resolving-paths).

| `check_type` | `params` (defaults in brackets) | Passes when |
| --- | --- | --- |
| `http_status` | `expected` [200] | the response status equals `expected` |
| `text_present` | `text` | the text is **visible** on the page (in the markup but hidden does not count) |
| `element_exists` | `selector` (CSS) | at least one element matches |
| `form_submits` | `form_selector` ["form"], `fields` {CSS selector → value}, `success` {`text`?, `url_contains`?, `response_status`?} (at least one) | after filling and submitting, every given success signal is observed within 10 s, **and** the success text was not already visible before submitting |
| `load_time_under` | `ms` (≤ 60000) | navigation `loadEventEnd − startTime` ≤ `ms` |
| `mobile_no_overflow` | `viewport_width` [390] | at that width (height 844), page scroll width ≤ viewport width + 1 px |
| `links_ok` | `max_links` [50] | every distinct http(s) link on the page (fragments dropped, first `max_links`) answers with a status below 400; a blocked or unreachable link counts as broken |
| `json_schema_valid` | `schema` (JSON Schema, draft-07) | the response parses as JSON and validates |
| `llm_judgement` | `question` (5–500 chars, yes/no) | an AI judge answers yes (see [§4.3](#43-verdicts)); always presented as "AI opinion" |
| `client_approval` | `{}` | never automated: the client decides |

### 3.3 Normalisation and hash

Before hashing, the contract MUST be validated and normalised: every default above is filled in explicitly. So a contract that omits a default and one that spells it out have the same hash.

```
contract_hash = hex(SHA-256(canonical_json(normalised_contract)))
```

Vector `contract`: `input_with_defaults_omitted` normalises to `normalised`, whose hash is `6f36f8f1…c04278f9`.

### 3.4 Agreement and binding

- Each party accepts a specific `contract_hash`. An implementation MUST refuse an acceptance of a hash that is no longer the current proposal. The contract is frozen (AGREED) only when both parties have accepted the same current hash. After that, any change MUST be rejected.
- The server running the verifiers sets `quorum` to its own panel. A party-supplied panel MUST be refused unless it is identical. A contract can only name keys its verifiers hold.
- The settler MUST put `contract_hash` in the PayPal order's `purchase_units[].custom_id` before funding (64 hex characters; PayPal documents a 127-character limit, to be confirmed in the rail spike). Anyone can then compare a receipt with PayPal's own record.

---

## 4. Running a verifier

A verifier receives the contract, the job ID and the deliverable URL. For each item in contract order it produces one **leaf**; then it builds a Merkle tree over the leaves and signs an **attestation**.

### 4.1 Resolving paths

- `path` `"/"` is the deliverable URL itself.
- Any other path is resolved relative to the deliverable URL's directory (query and fragment dropped). The result MUST stay inside that directory on the same origin; otherwise the item's verdict is `error` ("path points outside the deliverable").

### 4.2 Network safety

The deliverable is hostile input. A verifier MUST refuse requests to private, loopback, link-local and reserved addresses, except origins explicitly allowed (the demo sites a server hosts itself). The rule applies on every redirect hop and on DNS re-resolution: connect to the exact address that was checked. Kept does this with an egress proxy, plus a Node-side fetch for WebKit, whose macOS build connects to loopback directly (see the Decision Log in `CLAUDE.md`).

### 4.3 Verdicts

Each leaf has one vote:

| Vote | Meaning |
| --- | --- |
| `pass` | The check passed. |
| `fail` | The deliverable's fault: unreachable, wrong status, missing text, form did not confirm, … |
| `error` | The verifier could not decide: invalid selector or schema in the contract, path escapes, crash, timeout of the verifier itself, or a page it could not scan for injections. **Abstains.** |
| `needs_client` | A person must decide: always for `client_approval`; for `llm_judgement` when no AI judge is configured. |

**Injection.** Every page a check loads MUST be scanned for text aimed at AI evaluators: instruction-like text a person cannot see (hidden by CSS, zero size, off-screen, background-coloured, tiny fonts, `aria-*`, `alt`, `title`, `<meta>`, comments, `<noscript>`). If anything is found, the leaf has `injection: true` **and** `verdict: "fail"`, whatever the check said. An `llm_judgement` answer whose canary token is missing or wrong, or which reports `injection_suspected`, is also an injection.

### 4.4 Leaf record

```json
{ "m": 0, "i": 1, "check_type": "text_present", "verdict": "pass", "injection": false,
  "measured_value": null, "summary": "\"Acme\" is visible on …",
  "artifacts": { "details_sha256": "<hex>", "screenshot_sha256": "<hex>" } }
```

| Field | Rule |
| --- | --- |
| `m`, `i` | the item's position; MUST match contract order |
| `check_type` | MUST equal the contract item's |
| `verdict` | `pass` \| `fail` \| `needs_client` \| `error` |
| `injection` | boolean |
| `measured_value` | string ≤ 2000 chars, or `null` |
| `summary` | string ≤ 2000 chars, for people |
| `artifacts` | name (`^[a-z0-9_]{1,64}$`) → SHA-256 hex of the artifact's bytes. Names starting with `screenshot` are PNG; all others are JSON. Kept writes `screenshot_sha256` (if a page was shown) and `details_sha256` (canonical JSON of the check's details, tripwire findings and blocked requests). |

No other keys. Artifacts are committed by hash only. A server SHOULD serve them at `<base>/evidence/<sha256>.<png|json>`, so their address proves their content.

### 4.5 Merkle tree (RFC 6962 §2.1)

```
leaf_hash  = SHA-256(0x00 || canonical_json(leaf))
node_hash  = SHA-256(0x01 || left || right)
MTH([])    = SHA-256("")
MTH([x])   = leaf_hash(x)
MTH(D[n])  = node_hash(MTH(D[0:k]), MTH(D[k:n]))   where k is the largest power of two < n
```

Leaves go in contract order. Vector `rfc6962`: the leaf hash of the empty string is `6e340b9c…17afa01d` (the Certificate Transparency value). Vector `merkle` gives every leaf's canonical JSON, leaf hash and the root for three verifiers. Inclusion proofs follow RFC 6962 audit paths (`src/qaps/merkle.ts`).

### 4.6 Attestation

```json
{
  "payload": {
    "v": "kept-qaps/1", "type": "attestation",
    "job_id": "job_vectors01",
    "contract_hash": "<hex>",
    "deliverable_url": "https://deliverable.example/site/",
    "verifier_id": "verifier-a",
    "browser": "local-chromium 140.0",
    "judge_model": "claude-opus-5-5",
    "merkle_root": "<hex>",
    "leaf_count": 3,
    "issued_at": "2026-11-10T12:00:00.000Z"
  },
  "signature": "<base64url Ed25519 over canonical_json(payload)>",
  "key_fingerprint": "<hex>"
}
```

- `leaf_count` is signed because an RFC 6962 root alone does not pin the tree size.
- `browser` and `judge_model` say what actually ran, including fallbacks (e.g. `local-chromium 140.0 (fallback: no KERNEL_API_KEY)`), so a reader can judge panel diversity.
- `payload` strings: `job_id` ≤ 100, `deliverable_url` a URL ≤ 2000, `verifier_id` ≤ 64, `browser` and `judge_model` ≤ 100; `leaf_count` 0–10000.
- Vector `attestations` gives the exact signed bytes and signature for each verifier.

---

## 5. The quorum

### 5.1 The rule, per item

Given the ballots `(verdict, injection)` of the accepted reports and threshold `k`:

```
1. if check_type == "client_approval":     → needs_client, reason "client"
2. if count(injection) ≥ k:               → fail,         reason "injection"
3. pass_votes = count(verdict == pass and not injection)
   fail_votes = count(verdict == fail or injection)
   if pass_votes ≥ k:                     → pass,         reason "quorum"
   if fail_votes ≥ k:                     → fail,         reason "quorum"
4. otherwise                              → needs_client, reason "no_quorum"
```

`error` and `needs_client` votes count for neither side. A lone injection flag is a fail vote, not a veto, and it stays visible in the leaves.

Properties (exhaustively tested for 2-of-3 and 3-of-5 in `tests/quorum.test.ts`):

- **Omission safety.** Dropping reports from a certificate (keeping ≥ k) can never flip `pass`↔`fail`; at worst an item goes to the client. Votes only decrease when reports are dropped, and because `2k > n`, `pass_votes ≥ k` and `fail_votes ≥ k` cannot both hold. A veto would break this: dropping the one flagging report would turn the veto into a pass.
- **Fault tolerance.** If k honest verifiers agree, the other n − k cannot produce the opposite verdict.

Vector `quorum_rule` covers each branch.

### 5.2 Quorum certificate

```json
{ "v": "kept-qaps/1", "type": "quorum_certificate",
  "job_id": "…", "contract_hash": "…", "deliverable_url": "…",
  "k": 2, "n": 3,
  "attestations": [ <signed attestation>, … ],
  "items": [ { "m": 0, "i": 0, "verdict": "pass", "reason": "quorum" }, … ],
  "issued_at": "…" }
```

`attestations`: 1–7 entries, in the contract's verifier order. `items`: one per contract item, in contract order, with `verdict` ∈ {`pass`, `fail`, `needs_client`} and `reason` ∈ {`quorum`, `no_quorum`, `injection`, `client`}.

```
certificate_hash = hex(SHA-256(canonical_json(certificate)))
```

### 5.3 Validating a certificate (what a settler and every receipt verifier MUST do)

Inputs: the certificate, the contract, the leaves of each attesting verifier, and the expected `job_id`, `contract_hash` and `deliverable_url`.

1. The certificate is well-formed (§5.2).
2. `SHA-256(canonical_json(contract))` equals the expected `contract_hash`, and so does `certificate.contract_hash`.
3. `certificate.job_id` and `certificate.deliverable_url` equal the expected values.
4. `certificate.k`/`n` equal the contract's `quorum.k`/`n`.
5. For each attestation, with no verifier ID appearing twice:
   1. its `verifier_id` is listed in the contract's `quorum.verifiers`;
   2. `key_fingerprint` is the fingerprint of that listed key;
   3. the signature verifies over `canonical_json(payload)` (canonical base64url, §2.2);
   4. `payload.job_id`, `contract_hash` and `deliverable_url` equal the expected values;
   5. there is one leaf per contract item, `payload.leaf_count` equals the number of leaves, and each leaf is well-formed (§4.4) with the right `m`, `i` and `check_type`;
   6. the RFC 6962 root of the leaves equals `payload.merkle_root`.
6. At least `k` attestations passed step 5.
7. Applying §5.1 to every item, over exactly these attestations' leaves, gives `certificate.items` exactly (compare canonical JSON).

If any step fails, the certificate is invalid. A settler MUST NOT move money on an invalid certificate, and MUST NOT trust a stored "verified" flag instead of running these steps.

---

## 6. Outcomes and settlement

### 6.1 Client decisions

The client MAY decide (`approve` or `reject`) any item whose certificate verdict is `needs_client`, once. The client MUST NOT override an item the quorum decided.

### 6.2 Milestone outcome

For each milestone, take each item's final verdict: the certificate verdict, or for `needs_client` the client's decision (`approve` → pass, `reject` → fail).

- If any item is `fail`, the outcome is **failed**.
- Otherwise, if any item has no final verdict yet, the outcome is **pending**.
- Otherwise it is **passed**.

### 6.3 Settlement

A settler MUST, before any money moves:

1. recompute the contract hash and compare it with the agreed one;
2. validate the certificate per §5.3;
3. refuse while any milestone is pending.

Then it releases each passed milestone to the worker and refunds each failed one to the client. Each money call carries a deterministic idempotency key (`PayPal-Request-Id`): `kept:<job_id>:<milestone_id|job>:<action>`, or `kept:` + the first 48 hex characters of its SHA-256 if longer than 64 characters. A retry can then never pay twice. The certificate hash SHOULD be written onto the PayPal capture or refund where the API allows. Which fields to use is pending the PayPal rail spike (CLAUDE.md T1.4/TQ.9).

---

## 7. The Proof Receipt

### 7.1 Format

```json
{
  "v": "kept-qaps/1", "type": "proof_receipt",
  "job": { "id": "…", "title": "…", "status": "SETTLED", "rail": "auth_capture", "deliverable_url": "…" },
  "contract": { …normalised contract… },
  "contract_hash": "<hex>",
  "certificate": { …quorum certificate… },
  "certificate_hash": "<hex>",
  "leaves": { "verifier-a": [ …leaves… ], … },
  "artifacts": [ { "sha256": "<hex>", "kind": "png", "url": "https://…/evidence/<hex>.png" }, … ],
  "client_decisions": [ { "m": 1, "i": 0, "decision": "approve", "actor": "…", "note": null, "decided_at": "…" } ],
  "milestones": [ { "m": 0, "title": "…", "amount_cents": 3000, "outcome": "passed", "status": "released",
                    "paypal": { "capture_id": "…", "release_id": "…", "refund_id": null } } ],
  "paypal": { "order_id": "…", "contract_hash_field": "purchase_units[].custom_id" },
  "events": [ { "type": "…", "actor": "…", "payload": { … } | null, "at": "…" } ],
  "issued_at": "…",
  "seal": { … §7.2 … }
}
```

- `contract` MUST be the normalised contract (§3.3), so a verifier can hash it as given.
- `leaves` holds only the verifiers whose attestations are in the certificate, each in contract order, exactly as signed.
- `artifacts` lists each `(sha256, kind)` committed by those leaves exactly once. `url` MUST end in `/evidence/<sha256>.<kind>`.
- `milestones[].outcome` follows §6.2. `status` is the issuer's record of what the money did (`pending`, `passed`, `failed`, `released`, `refunded`). `released` requires outcome `passed`, and `refunded` requires `failed`.
- Kept serves receipts at `GET /jobs/:id/receipt`, and `?download=1` makes it a file download.

### 7.2 The issuer seal

The proven sections do not cover the issuer's own records: PayPal IDs, events, status and issue time. The seal does:

```json
"seal": {
  "v": "kept-qaps/1", "type": "receipt_seal",
  "issuer": "kept-issuer",
  "public_key": "<43 chars>",
  "key_fingerprint": "<hex>",
  "sections": { "artifacts": "<hex>", "certificate": "<hex>", …one per top-level key except seal… },
  "signature": "<base64url Ed25519 over canonical_json(seal without signature)>"
}
```

`sections[name] = hex(SHA-256(canonical_json(receipt[name])))` for every top-level key except `seal`.

The seal proves only that *the holder of this key* issued the receipt. Anyone can re-seal an edited receipt with their own key. A verifier MUST therefore compare `key_fingerprint` with the issuer key the Kept server publishes at `/.well-known/kept/issuer.json` before trusting the bookkeeping sections. The proven sections never depend on the seal.

### 7.3 Verifying a receipt

Run these named checks, in this order, and report each. Both implementations use exactly these names.

| # | Check | Passes when |
| --- | --- | --- |
| 1 | `format` | the receipt matches §7.1 (strict). If it does not, stop. |
| 2 | `seal_sections` | every recomputed section hash equals `seal.sections`, with no section missing or extra. On failure, name the changed sections. |
| 3 | `seal_signature` | `key_fingerprint` matches `public_key` and the signature verifies |
| 4 | `issuer_key` | (only when an expected issuer fingerprint is given) it equals `seal.key_fingerprint` |
| 5 | `contract_hash` | `SHA-256(canonical_json(contract))` equals `contract_hash` (a malformed contract fails here as `contract`; stop) |
| 6 | `certificate` | §5.3 with expected values from `job.id`, `contract_hash` and `job.deliverable_url` (a malformed leaf fails first as `leaves`; stop on failure) |
| 7 | `certificate_hash` | `SHA-256(canonical_json(certificate))` equals `certificate_hash` |
| 8 | `leaves` | no leaves from a verifier without an attestation in the certificate |
| 9 | `artifacts` | the artifact list equals the set committed by the leaves, and every URL ends in `/evidence/<sha256>.<kind>` |
| 10 | `client_decisions` | each decision is on a `needs_client` item, at most one per item |
| 11 | `milestones` | one per contract milestone, titles and amounts match, outcomes follow §6.2, and status agrees with outcome |

Online steps, when the verifier can reach the network:

- `artifact_bytes`: download every artifact and check that its bytes hash to its name.
- Fetch `/.well-known/kept/issuer.json` from the receipt's server and use it for `issuer_key`.
- Check in PayPal that order `paypal.order_id` carries `custom_id = contract_hash`. A tool can only remind the user; PayPal requires credentials.

Vector `receipt` passes every check. Vector `tampered_receipt` changes one PayPal release ID, so only `seal_sections` fails, with "changed since sealing: milestones".

---

## 8. Publishing keys

| Path | Body |
| --- | --- |
| `GET /.well-known/kept/verifiers.json` | `{ "protocol": "kept-qaps/1", "verifiers": [ { "id", "alg": "Ed25519", "public_key", "fingerprint" } ] }`: a convenience for building contracts. Receipts trust the keys **in the contract**, not this list. |
| `GET /.well-known/kept/issuer.json` | `{ "protocol": "kept-qaps/1", "issuer": { "id": "kept-issuer", "alg": "Ed25519", "public_key", "fingerprint" } }` |

---

## 9. Security considerations *(informative)*

- **What a valid receipt proves:** the contract with this hash was checked by at least k of the verifier keys it names. Those verifiers attested exactly these leaves, the verdicts follow from them by the quorum rule, and the milestone outcomes follow from those verdicts and the client's decisions.
- **What it does not prove:** that the verifiers are honest or independent. In the reference deployment all n verifiers run on one server, and the protocol lets independent operators run them. Nor does it prove that the bookkeeping is true unless the issuer key is the published one, or that money moved unless PayPal's own records agree. Check the order's `custom_id` and the capture/refund IDs in PayPal.
- **Prompt injection.** Tripwires and canary tokens *reduce* the risk that page content steers an AI judge; they do not eliminate it. Deterministic checks decide everything they can, and the AI answers only narrow yes/no questions. A known false-positive class: an article about prompt injection inside a collapsed section.
- **Hostile deliverables** try to make verifiers fetch internal addresses (SSRF). §4.2 is mandatory, including redirect hops and engines that bypass proxies for loopback.
- **Malleability.** Accept canonical base64url only (§2.2), compare hashes as lowercase hex, and use strict object shapes. Otherwise the same data has many encodings and "changed one byte, still valid" bugs appear.
- **Timing.** A held payment auto-releases to the worker at PayPal's hold limit (documented as 28 days for delayed disbursement), so a silent client cannot block payment forever.

---

## 10. Test vectors

[`docs/protocol-vectors.json`](protocol-vectors.json) is generated by `npm run protocol-vectors -- --write` from fixed seeds (`SHA-256("kept-protocol-vectors:" + id)`). Ed25519 signatures are deterministic, so every byte is reproducible. **The keys are public: never use them for anything real.**

| Vector | Contains |
| --- | --- |
| `keys` | seeds, public keys and fingerprints for verifier-a/b/c and kept-issuer |
| `canonical_json` | input and canonical output (§2.1) |
| `contract` | contract with defaults omitted, normalised form, canonical JSON, hash `6f36f8f1173ea8ad6c25aa439c58f7fd8f2c6a842923349b0834c6eec04278f9` |
| `rfc6962` | leaf hashes of `""`, `"a"`, `"b"`, two- and three-leaf roots, empty root |
| `merkle` | per verifier: leaf canonical JSON, leaf hashes, Merkle root |
| `attestations` | exact signed bytes and signed attestations |
| `certificate` | the certificate (verifier-c dissents on one item and is outvoted) and its hash |
| `quorum_rule` | ballots → decision for each branch of §5.1 |
| `receipt` | a sealed receipt and the expected result of §7.3 (all pass) |
| `tampered_receipt` | one changed PayPal ID and the expected result (only `seal_sections` fails) |

`tests/protocol-vectors.test.ts` regenerates the file and fails if it differs. It also checks the vectors with both reference verifiers.

---

## 11. Reference implementation

| Part | Code |
| --- | --- |
| Contract schema, normalisation, canonical JSON, hash | `src/core/checklist.ts` |
| Checks and path resolution | `src/verifier/checks/index.ts` |
| Network guard (egress proxy, WebKit Node-side fetch) | `src/verifier/egress-proxy.ts`, `src/verifier/browser.ts`, `src/verifier/url-guard.ts` |
| Tripwire scanner | `src/verifier/tripwire.ts`, `src/verifier/tripwire.page.js` |
| Leaf, Merkle tree | `src/qaps/leaf.ts`, `src/qaps/merkle.ts` |
| Keys, attestations | `src/qaps/keys.ts`, `src/qaps/attestation.ts` |
| Quorum rule, certificate, validation, outcomes | `src/qaps/quorum.ts` |
| Single verifier, orchestrator | `src/verifier/runner.ts`, `src/verifier/orchestrator.ts` |
| Settlement | `src/core/settlement.ts` |
| Receipt, seal, verification | `src/qaps/receipt.ts`, `src/core/receipt-store.ts` |
| Standalone receipt verifier (no dependencies) | `tools/verify-receipt.mjs`: `node tools/verify-receipt.mjs <file\|url>` |

Not yet implemented: the `llm_judgement` AI judge and canary (T3.6/TQ.5; until then those items go to the client), the PayPal rails (T2.3), and binding the certificate hash onto PayPal records (TQ.9).
