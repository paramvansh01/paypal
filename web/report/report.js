// Kept evidence report (T3.9). Renders a job's Proof Receipt for people.
//
// Everything shown comes from GET /jobs/:id/receipt (the proof itself) plus
// GET /jobs/:id for live status and replay links. Deliverables are hostile
// input and their text reaches this page through summaries, so all data is set
// with textContent or safe attributes — never innerHTML.

const app = document.getElementById("app");
const jobId = decodeURIComponent(location.pathname.split("/")[2] ?? "");

/** el("p", { class: "x" }, "text", child) — children are strings (as text) or nodes. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    node.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const money = (cents, currency) => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
const short = (hex) => `${hex.slice(0, 12)}…${hex.slice(-6)}`;
const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
};
const badge = (value, label = value) => el("span", { class: `badge v-${String(value).replace(/[^a-z_]/gi, "")}` }, label);
const VOTE_LABEL = { pass: "pass", fail: "fail", needs_client: "client decides", error: "abstained" };
const REASON_LABEL = { quorum: "quorum agreed", no_quorum: "no quorum — client decides", injection: "injection caught", client: "client decides" };
const KIND_LABEL = {
  http_status: "HTTP status",
  text_present: "Text visible",
  element_exists: "Element exists",
  form_submits: "Form submits",
  load_time_under: "Load time",
  mobile_no_overflow: "Mobile layout",
  links_ok: "Links work",
  json_schema_valid: "JSON schema",
  llm_judgement: "AI opinion",
  client_approval: "Client approval",
};
/** Only same-origin evidence, rebuilt from the hash: never follow a URL taken from the receipt. */
const evidenceUrl = (sha, kind) => (/^[0-9a-f]{64}$/.test(sha) ? `/evidence/${sha}.${kind}` : null);
/** Links to the deliverable are shown, but opened without referrer or opener. */
const safeHref = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
};

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function load() {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(jobId)) return showError("This is not a job address.");
  const [job, receipt] = await Promise.all([getJson(`/jobs/${encodeURIComponent(jobId)}`), getJson(`/jobs/${encodeURIComponent(jobId)}/receipt`)]);
  if (job.status === 404) return showError(`There is no job ${jobId}.`);
  if (job.status !== 200) return showError(job.body.error ?? "Could not load the job.");
  document.title = `${job.body.title} · Evidence · Kept`;
  if (receipt.status !== 200) return showPending(job.body);
  render(receipt.body, job.body);
}

function showError(message) {
  app.replaceChildren(el("h1", {}, "Evidence report"), el("p", { class: "muted" }, message));
}

/** Before a certificate exists: say where the job is, and refresh while verifiers run. */
function showPending(job) {
  const verifying = job.status === "VERIFYING";
  app.replaceChildren(
    el("h1", {}, job.title),
    el("p", {}, badge("info", job.status), " ", verifying ? "The verifiers are checking the work. This page refreshes on its own." : "There is no evidence yet: the work has not been verified."),
  );
  if (verifying) setTimeout(load, 3000);
}

function render(r, job) {
  const contract = r.contract;
  const cert = r.certificate;
  const currency = contract.currency;
  const verifiers = cert.attestations.map((a) => a.payload);
  const leavesBy = r.leaves;
  const items = new Map(cert.items.map((x) => [`${x.m}.${x.i}`, x]));
  const decisions = new Map(r.client_decisions.map((d) => [`${d.m}.${d.i}`, d]));
  const replay = new Map((job.verification?.runs ?? []).map((run) => [run.verifier_id, run.replay_url]));
  const sum = (status) => r.milestones.filter((m) => m.status === status).reduce((t, m) => t + m.amount_cents, 0);
  const injected = [...items.values()].filter((x) => x.reason === "injection");
  const lone = [];
  for (const id of Object.keys(leavesBy)) for (const l of leavesBy[id]) if (l.injection && items.get(`${l.m}.${l.i}`)?.reason !== "injection") lone.push({ id, leaf: l });

  const deliverableHref = safeHref(r.job.deliverable_url);
  const receiptUrl = `/jobs/${encodeURIComponent(r.job.id)}/receipt`;

  const nodes = [];

  // Header
  nodes.push(
    el(
      "div",
      { class: "head" },
      el(
        "div",
        {},
        el("h1", {}, r.job.title),
        el(
          "p",
          { class: "muted" },
          badge(r.job.status === "SETTLED" ? "released" : "info", r.job.status),
          " Job ",
          el("code", {}, r.job.id),
          " · delivered at ",
          deliverableHref ? el("a", { href: deliverableHref, rel: "noopener noreferrer nofollow", target: "_blank" }, r.job.deliverable_url) : el("code", {}, r.job.deliverable_url),
        ),
      ),
      el(
        "div",
        { class: "actions" },
        el("a", { class: "btn primary", href: `${receiptUrl}?download=1`, download: `kept-receipt-${r.job.id}.json` }, "Download Proof Receipt"),
        el("a", { class: "btn", href: receiptUrl }, "View raw JSON"),
      ),
    ),
  );

  // Money at a glance
  nodes.push(
    el(
      "div",
      { class: "summary" },
      stat("Contract value", money(contract.total_cents, currency)),
      stat("Released to worker", money(sum("released"), currency)),
      stat("Refunded to client", money(sum("refunded"), currency)),
      stat("Verifiers", `${cert.k} of ${cert.n} must agree`),
    ),
  );

  if (injected.length) {
    nodes.push(
      el(
        "div",
        { class: "alert", role: "alert" },
        el("strong", {}, "Prompt-injection attempt caught"),
        el("p", {}, `The deliverable hid instructions aimed at the AI verifiers on ${injected.length} item(s). Those items failed, and the money for them was not paid out.`),
      ),
    );
  }

  // Contract and proof
  nodes.push(el("h2", {}, "The contract and its proof"));
  nodes.push(
    el(
      "section",
      { class: "panel" },
      el(
        "dl",
        { class: "facts" },
        el("dt", {}, "Contract fingerprint"),
        el("dd", {}, el("code", { title: r.contract_hash }, r.contract_hash)),
        el("dt", {}, "On PayPal"),
        el("dd", {}, r.paypal.order_id ? ["order ", el("code", {}, r.paypal.order_id), " carries it as ", el("code", {}, "custom_id")] : "not funded through PayPal yet"),
        el("dt", {}, "Quorum certificate"),
        el("dd", {}, el("code", { title: r.certificate_hash }, r.certificate_hash)),
        el("dt", {}, "Sealed by"),
        el("dd", {}, `${r.seal.issuer} · key `, el("code", {}, short(r.seal.key_fingerprint)), ` · ${when(r.issued_at)}`),
      ),
      el(
        "details",
        {},
        el("summary", {}, "Check this receipt yourself"),
        el("p", {}, "Anyone can recompute every hash, Merkle root and signature with the standalone verifier (plain Node, nothing to install):"),
        el("code", { class: "cmd" }, `node tools/verify-receipt.mjs ${location.origin}${receiptUrl}`),
      ),
    ),
  );

  // Verifier panel
  nodes.push(el("h2", {}, "Who checked the work"));
  nodes.push(
    el(
      "div",
      { class: "panel-grid" },
      verifiers.map((v) => {
        const key = contract.quorum.verifiers.find((x) => x.id === v.verifier_id);
        const rp = safeHref(replay.get(v.verifier_id) ?? "");
        return el(
          "div",
          { class: "card" },
          el("h3", {}, v.verifier_id),
          el(
            "dl",
            { class: "facts" },
            el("dt", {}, "Browser"),
            el("dd", {}, v.browser),
            el("dt", {}, "AI judge"),
            el("dd", {}, v.judge_model),
            el("dt", {}, "Evidence root"),
            el("dd", {}, el("code", { title: v.merkle_root }, short(v.merkle_root))),
            el("dt", {}, "Signing key"),
            el("dd", {}, el("code", { title: key?.public_key ?? "" }, key ? short(key.public_key) : "?")),
            el("dt", {}, "Signed"),
            el("dd", {}, when(v.issued_at)),
          ),
          rp ? el("p", {}, el("a", { href: rp, rel: "noopener noreferrer", target: "_blank" }, "Watch the browser replay")) : null,
        );
      }),
    ),
  );

  // Milestones and items, verifiers side by side
  nodes.push(el("h2", {}, "Milestones, item by item"));
  contract.milestones.forEach((ms, m) => {
    const rec = r.milestones[m];
    const paypal = rec.paypal.release_id ? ["released as ", el("code", {}, rec.paypal.release_id)] : rec.paypal.refund_id ? ["refunded as ", el("code", {}, rec.paypal.refund_id)] : null;
    nodes.push(
      el(
        "section",
        { class: "panel milestone", "data-milestone": m },
        el(
          "div",
          { class: "head" },
          el("div", {}, el("h3", {}, `${m + 1}. ${ms.title}`), el("p", { class: "muted" }, money(ms.amount_cents, currency), paypal ? [" · ", ...paypal] : null)),
          el("div", {}, badge(rec.outcome), " ", rec.status !== rec.outcome ? badge(rec.status) : null),
        ),
        el(
          "div",
          { class: "table-wrap" },
          el(
            "table",
            {},
            el(
              "thead",
              {},
              el("tr", {}, el("th", {}, "Check"), verifiers.map((v) => el("th", {}, v.verifier_id)), el("th", {}, "Result")),
            ),
            el(
              "tbody",
              {},
              ms.items.map((item, i) => {
                const final = items.get(`${m}.${i}`);
                const decision = decisions.get(`${m}.${i}`);
                return el(
                  "tr",
                  { "data-item": `${m}.${i}` },
                  el("td", {}, el("strong", {}, item.description), el("div", { class: "muted" }, KIND_LABEL[item.check_type] ?? item.check_type)),
                  verifiers.map((v) => voteCell(leavesBy[v.verifier_id]?.[contractIndex(contract, m, i)])),
                  el(
                    "td",
                    { class: "vote" },
                    badge(final.verdict, VOTE_LABEL[final.verdict] ?? final.verdict),
                    el("div", { class: "why" }, REASON_LABEL[final.reason] ?? final.reason),
                    decision
                      ? el("div", { class: "why" }, badge(decision.decision, decision.decision === "approve" ? "client approved" : "client rejected"), decision.note ? ` “${decision.note}”` : null)
                      : null,
                  ),
                );
              }),
            ),
          ),
        ),
      ),
    );
  });

  if (lone.length) {
    nodes.push(
      el(
        "p",
        { class: "muted" },
        `${lone.length} lone injection flag(s) were outvoted by the other verifiers; they stay in the evidence above.`,
      ),
    );
  }

  // Timeline
  nodes.push(el("h2", {}, "Timeline"));
  const quiet = r.events.filter((e) => e.type === "VERIFIER_ITEM").length;
  nodes.push(
    el(
      "section",
      { class: "panel" },
      el("ol", { class: "timeline" }, r.events.filter((e) => e.type !== "VERIFIER_ITEM").map((e) => el("li", {}, el("time", { datetime: e.at }, when(e.at)), el("span", {}, describe(e))))),
      quiet ? el("p", { class: "muted" }, `Plus ${quiet} per-item progress events from the verifiers (in the receipt).`) : null,
    ),
  );

  app.replaceChildren(...nodes);
}

function stat(label, value) {
  return el("div", { class: "stat" }, el("span", { class: "muted" }, label), el("b", {}, value));
}

function contractIndex(contract, m, i) {
  let idx = 0;
  for (let mm = 0; mm < m; mm++) idx += contract.milestones[mm].items.length;
  return idx + i;
}

function voteCell(leaf) {
  if (!leaf) return el("td", { class: "vote" }, el("span", { class: "muted" }, "—"));
  const shot = leaf.artifacts.screenshot_sha256 && evidenceUrl(leaf.artifacts.screenshot_sha256, "png");
  const details = leaf.artifacts.details_sha256 && evidenceUrl(leaf.artifacts.details_sha256, "json");
  return el(
    "td",
    { class: "vote" },
    badge(leaf.verdict, VOTE_LABEL[leaf.verdict] ?? leaf.verdict),
    leaf.injection ? el("div", { class: "flag" }, "⚠ injection") : null,
    leaf.summary.length > 180
      ? el("details", { class: "why" }, el("summary", {}, `${leaf.summary.slice(0, 160).trimEnd()}… more`), leaf.summary)
      : el("div", { class: "why" }, leaf.summary),
    leaf.measured_value ? el("div", { class: "why" }, "Measured: ", el("code", {}, leaf.measured_value)) : null,
    shot ? el("a", { href: shot, target: "_blank", rel: "noopener" }, el("img", { class: "thumb", src: shot, alt: "Screenshot this verifier took", loading: "lazy" })) : null,
    el("div", { class: "links" }, shot ? el("a", { href: shot, target: "_blank", rel: "noopener" }, "screenshot") : null, details ? el("a", { href: details, target: "_blank", rel: "noopener" }, "details") : null),
  );
}

/** One readable line per event. */
function describe(e) {
  const p = e.payload ?? {};
  switch (e.type) {
    case "STATUS_CHANGED":
      return `${p.from} → ${p.to}${p.paypal_order_id ? ` (PayPal order ${p.paypal_order_id})` : ""}${p.deliverable_url ? ` (${p.deliverable_url})` : ""} · by ${e.actor}`;
    case "JOB_POSTED":
      return `Job posted by ${e.actor}`;
    case "CHECKLIST_ACCEPTED":
      return `${e.actor} accepted contract ${short(String(p.checklist_hash ?? ""))}`;
    case "CHECKLIST_REVISED":
      return `${e.actor} revised the contract`;
    case "INJECTION_DETECTED":
      return `Prompt-injection attempt caught on item ${Number(p.m) + 1}.${Number(p.i) + 1}`;
    case "INJECTION_SUSPECTED":
      return `One verifier flagged a possible injection on item ${Number(p.m) + 1}.${Number(p.i) + 1} (outvoted)`;
    case "MILESTONE_RELEASED":
      return `Milestone ${Number(p.position) + 1} released (${p.paypal_id ?? "no PayPal id"})`;
    case "MILESTONE_REFUNDED":
      return `Milestone ${Number(p.position) + 1} refunded (${p.paypal_id ?? "no PayPal id"})`;
    case "ITEM_APPROVED":
    case "ITEM_REJECTED":
      return `Client ${e.type === "ITEM_APPROVED" ? "approved" : "rejected"} item ${Number(p.m) + 1}.${Number(p.i) + 1}`;
    default:
      return `${e.type.replace(/_/g, " ").toLowerCase()} · ${e.actor}`;
  }
}

load().catch((err) => showError(`Could not load the evidence: ${err?.message ?? err}`));
