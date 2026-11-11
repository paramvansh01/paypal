// Kept web app (T5). Build-free ES module, served under a strict CSP.
//
// Views: "/" job list (+ judge-mode demo buttons), "/app/new" post a job,
// "/app/jobs/:id" job detail with live verdicts, actions for the signed-in
// party, the money panel and the timeline. Everything comes from the REST API.
// Text from jobs and deliverables is untrusted: it is only ever set with
// textContent or attributes, never innerHTML.

const app = document.getElementById("app");
const who = document.getElementById("who");
const bannerEl = document.getElementById("banner");

// ---------- small helpers ----------

/** el("p", { class: "x", onclick: fn }, "text", child) */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}
const money = (cents, currency = "USD") => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
};
const badge = (value, label = value) => el("span", { class: `badge v-${String(value).replace(/[^a-z_]/gi, "")}` }, label);
const safeHref = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
};
const KIND = {
  http_status: "HTTP status", text_present: "Text visible", element_exists: "Element exists", form_submits: "Form submits",
  load_time_under: "Load time", mobile_no_overflow: "Mobile layout", links_ok: "Links work", json_schema_valid: "JSON schema",
  llm_judgement: "AI opinion", client_approval: "Client approval",
};
const VERDICT = { pass: "pass", fail: "fail", needs_client: "client decides" };
const REASON = { quorum: "quorum agreed", no_quorum: "verifiers split", injection: "injection caught", client: "client decides" };
const STEPS = ["DRAFT", "CHECKLIST_PROPOSED", "AGREED", "FUNDING_PENDING", "FUNDED", "DELIVERED", "VERIFYING", "VERIFIED", "SETTLED"];
const STEP_LABEL = {
  DRAFT: "Draft", CHECKLIST_PROPOSED: "Contract proposed", AGREED: "Agreed", FUNDING_PENDING: "Awaiting PayPal", FUNDED: "Funded",
  DELIVERED: "Delivered", VERIFYING: "Verifying", VERIFIED: "Verified", SETTLED: "Settled",
};

// ---------- session ----------

const TOKEN_KEY = "kept.token";
function storedToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
function storeToken(t) {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the token lives for this page only */
  }
  state.token = t;
}

const state = { token: storedToken(), me: null, health: null };

async function api(method, path, body) {
  const headers = { accept: "application/json" };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function loadMe() {
  state.me = null;
  if (!state.token) return;
  try {
    state.me = await api("GET", "/me");
  } catch {
    storeToken(null);
  }
}

function renderWho() {
  const kids = [];
  if (state.me) {
    kids.push(el("span", {}, "Acting as ", el("b", {}, state.me.display_name), el("span", { class: "muted" }, ` (${state.me.party_id})`)));
    kids.push(el("button", { class: "small", onclick: () => { storeToken(null); state.me = null; route(); } }, "Sign out"));
  } else {
    kids.push(el("button", { class: "small", onclick: () => showSignIn() }, "Sign in"));
  }
  who.replaceChildren(...kids);
}

function renderBanner() {
  const h = state.health;
  if (!h) return bannerEl.replaceChildren();
  if (h.money === "offline") {
    bannerEl.replaceChildren(el("div", { class: "banner offline" }, "OFFLINE stand-in for PayPal: the PayPal sandbox is not connected yet, so no money moves. Every payment ID starts with OFFLINE-. Verification and Proof Receipts are real."));
  } else if (h.money === "none") {
    bannerEl.replaceChildren(el("div", { class: "banner none" }, "PayPal is not connected on this server yet: contracts, delivery and verification work, locking and settling funds do not."));
  } else bannerEl.replaceChildren();
}

function showSignIn(message) {
  const input = el("input", { type: "password", placeholder: "party_xxx.0123…", autocomplete: "off", "aria-label": "Party token" });
  const err = el("p", { class: "form-error" }, message ?? "");
  const go = async (token) => {
    storeToken(token.trim());
    await loadMe();
    if (!state.me) {
      err.textContent = "That token is not valid on this server.";
      return;
    }
    route();
  };
  const demo = state.health?.demo_mode
    ? el("div", { class: "row dialog" },
        el("span", { class: "muted" }, "Judge mode:"),
        ...["client", "worker"].map((role) =>
          el("button", { onclick: async () => {
            try {
              const s = await api("POST", "/demo/session", { role });
              await go(s.token);
            } catch (e) {
              err.textContent = e.message;
            }
          } }, `Act as the demo ${role}`)))
    : null;
  app.replaceChildren(
    el("h1", {}, "Sign in"),
    el("section", { class: "panel" },
      el("p", {}, "Kept parties sign in with a party token. Print one with ", el("code", {}, "npm run party-token -- <party_id>"), "."),
      el("label", {}, "Party token"),
      input,
      el("div", { class: "row dialog" }, el("button", { class: "primary", onclick: () => go(input.value) }, "Sign in"), el("a", { href: "/" }, "Cancel")),
      demo,
      err,
    ),
  );
  input.focus();
}

// ---------- router ----------

let timer = null;
function route() {
  clearTimeout(timer);
  renderWho();
  const p = location.pathname;
  const m = p.match(/^\/app\/jobs\/([A-Za-z0-9_-]{1,100})$/);
  if (m) return detailView(m[1]);
  if (p === "/app/new") return newJobView();
  return listView();
}
function go(path) {
  history.pushState(null, "", path);
  route();
}
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("a[data-nav]");
  if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
    e.preventDefault();
    go(a.getAttribute("href"));
  }
});
window.addEventListener("popstate", route);

// ---------- list ----------

async function listView() {
  document.title = "Kept · Proof-Carrying Payments";
  const mine = new URLSearchParams(location.search).has("mine") && state.me;
  const { jobs } = await api("GET", `/jobs?limit=100${mine ? `&party=${encodeURIComponent(state.me.party_id)}` : ""}`);
  const demoBox = state.health?.demo_mode ? demoRunBox() : null;
  const table = jobs.length
    ? el("div", { class: "table-wrap" }, el("table", { class: "list" },
        el("thead", {}, el("tr", {}, el("th", {}, "Job"), el("th", {}, "Status"), el("th", {}, "Amount"), el("th", {}, "Client → worker"), el("th", {}, "Posted"))),
        el("tbody", {}, jobs.map((j) => el("tr", { "data-job": j.id },
          el("td", {}, el("a", { href: `/app/jobs/${j.id}`, "data-nav": true }, j.title)),
          el("td", {}, badge(j.status.toLowerCase(), STEP_LABEL[j.status] ?? j.status)),
          el("td", {}, money(j.total_cents, j.currency)),
          el("td", { class: "muted" }, `${j.client_id} → ${j.worker_id ?? "—"}`),
          el("td", { class: "muted" }, when(j.created_at)),
        )))))
    : el("p", { class: "muted" }, mine ? "You have no jobs yet." : "No jobs yet.");
  app.replaceChildren(
    el("section", { class: "hero" },
      el("h1", {}, "Pay only if the work passes."),
      el("p", {}, "A client and a worker agree a machine-checkable contract. PayPal holds the money. Three independent verifiers check the delivery, sign what they saw, and each milestone is released only when two of them agree it passed. Every payout comes with a Proof Receipt anyone can verify."),
      el("div", { class: "row" },
        state.me ? el("a", { class: "btn primary", href: "/app/new", "data-nav": true }, "Post a job") : el("button", { class: "primary", onclick: () => showSignIn() }, "Sign in to post a job"),
        state.me ? el("a", { class: "btn", href: mine ? "/" : "/?mine", "data-nav": true }, mine ? "All jobs" : "My jobs") : null,
      ),
    ),
    demoBox,
    el("h2", {}, mine ? "My jobs" : "Jobs"),
    table,
  );
  timer = setTimeout(() => location.pathname === "/" && listView().catch(() => {}), 4000);
}

function demoRunBox() {
  const err = el("p", { class: "form-error" });
  const start = async (site, btn) => {
    btn.disabled = true;
    try {
      const r = await api("POST", "/demo/run", { site });
      go(`/app/jobs/${r.job_id}`);
    } catch (e) {
      err.textContent = e.message;
      btn.disabled = false;
    }
  };
  const button = (site, label) => {
    const b = el("button", { onclick: () => start(site, b) }, label);
    return b;
  };
  return el("section", { class: "panel action" },
    el("h2", {}, "Run the demo"),
    el("p", {}, "Two AI agents do a whole job over Kept's MCP server: the buyer posts a bakery website job and pays, the worker delivers, the verifier quorum checks it, and settlement pays or refunds each $25 milestone."),
    el("div", { class: "row" },
      button("good", "Good delivery (all pass)"),
      button("flawed", "Flawed delivery (contact form broken)"),
      button("sneaky", "Sneaky delivery (hides a prompt injection)"),
    ),
    err,
  );
}

// ---------- new job ----------

async function newJobView() {
  document.title = "Post a job · Kept";
  if (!state.me) return showSignIn("Sign in as the client who will pay.");
  const [{ parties }, contract] = await Promise.all([api("GET", "/parties"), api("GET", "/demo/contract.json")]);
  const workers = parties.filter((p) => p.id !== state.me.party_id);
  const f = {
    title: el("input", { type: "text", value: "Halcyon Crumb bakery website", maxlength: 200 }),
    brief: el("textarea", { rows: 3, class: "brief" }),
    worker: el("select", {}, workers.map((p) => el("option", { value: p.id }, `${p.display_name} (${p.id})`))),
    budget: el("input", { type: "number", min: "1", step: "0.01", value: String(contract.total_cents / 100) }),
    checklist: el("textarea", { spellcheck: "false" }),
  };
  f.brief.value = "A small bakery website: home page, menu, a working contact form, mobile friendly and fast.";
  f.checklist.value = JSON.stringify(contract, null, 2);
  const err = el("p", { class: "form-error" });
  const draft = state.health?.ai
    ? el("button", { onclick: async () => {
        err.textContent = "";
        draft.disabled = true;
        draft.textContent = "Drafting…";
        try {
          const r = await api("POST", "/checklists/generate", { brief: f.brief.value, budget_cents: Math.round(Number(f.budget.value) * 100) });
          f.checklist.value = JSON.stringify(r.checklist, null, 2);
          err.textContent = "AI draft loaded below. Review every item before posting: both parties accept exactly this contract.";
        } catch (e) {
          err.textContent = e.message;
        }
        draft.disabled = false;
        draft.textContent = "Draft the contract with AI";
      } }, "Draft the contract with AI")
    : null;
  const submit = el("button", { class: "primary", onclick: async () => {
    err.textContent = "";
    let checklist;
    try {
      checklist = JSON.parse(f.checklist.value);
    } catch {
      err.textContent = "The checklist is not valid JSON.";
      return;
    }
    submit.disabled = true;
    try {
      const job = await api("POST", "/jobs", {
        title: f.title.value, brief: f.brief.value, worker_id: f.worker.value,
        budget_cents: Math.round(Number(f.budget.value) * 100), currency: checklist.currency ?? "USD", checklist,
      });
      go(`/app/jobs/${job.id}`);
    } catch (e) {
      err.textContent = e.message;
      submit.disabled = false;
    }
  } }, "Post job and propose this contract");
  app.replaceChildren(
    el("p", {}, el("a", { href: "/", "data-nav": true }, "← All jobs")),
    el("h1", {}, "Post a job"),
    el("section", { class: "panel" },
      el("p", { class: "muted" }, `You are the client (${state.me.display_name}). The worker must accept the same contract before you lock funds.`),
      el("label", {}, "Title"), f.title,
      el("label", {}, "Brief"), f.brief,
      el("label", {}, "Worker"), f.worker,
      el("label", {}, "Budget (USD) ", el("span", { class: "muted" }, "— must equal the contract total")), f.budget,
      el("label", {}, "Contract ", el("span", { class: "muted" }, "— milestones with machine-checkable items. Paths are relative to the URL the worker delivers. The server adds its verifier panel.")),
      draft ? el("div", { class: "row" }, draft, el("span", { class: "muted" }, "from the brief and budget above")) : null,
      f.checklist,
      el("div", { class: "row dialog" }, submit, el("a", { href: "/", "data-nav": true }, "Cancel")),
      err,
    ),
  );
}

// ---------- job detail ----------

let lastSnapshot = "";

async function detailView(id, opts = {}) {
  const [job, ledger, ev, run] = await Promise.all([
    api("GET", `/jobs/${id}`).catch((e) => (e.status === 404 ? null : Promise.reject(e))),
    api("GET", `/jobs/${id}/ledger`).catch(() => null),
    api("GET", `/jobs/${id}/events`).catch(() => ({ events: [] })),
    state.health?.demo_mode ? api("GET", `/demo/runs/${id}`).then((r) => (r.stage ? r : null)).catch(() => null) : null,
  ]);
  if (!job) {
    app.replaceChildren(el("h1", {}, "Not found"), el("p", { class: "muted" }, `There is no job ${id}.`), el("a", { href: "/", "data-nav": true }, "← All jobs"));
    return;
  }
  const snapshot = JSON.stringify([job, ledger, ev, run, state.me?.party_id]);
  const typing = document.activeElement && ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName) && app.contains(document.activeElement);
  if (opts.poll && (snapshot === lastSnapshot || typing)) return schedule(id, job, run);
  lastSnapshot = snapshot;
  document.title = `${job.title} · Kept`;

  const role = state.me ? (state.me.party_id === job.client_id ? "client" : state.me.party_id === job.worker_id ? "worker" : null) : null;
  app.replaceChildren(
    el("p", {}, el("a", { href: "/", "data-nav": true }, "← All jobs")),
    el("div", { class: "head" },
      el("div", {},
        el("h1", {}, job.title),
        el("p", { class: "muted" }, job.brief),
      ),
      el("div", { class: "row" }, badge(job.status.toLowerCase(), STEP_LABEL[job.status] ?? job.status), el("b", {}, money(job.total_cents, job.currency))),
    ),
    stepper(job.status),
    run ? demoRunPanel(id, run) : null,
    actionPanel(job, role),
    el("div", { class: "grid2 gap-top" }, moneyPanel(job, ledger), proofPanel(job)),
    contractPanel(job, role, liveVotes(ev.events)),
    timelinePanel(ev.events),
  );
  const log = app.querySelector(".log");
  if (log) log.scrollTop = log.scrollHeight;
  schedule(id, job, run);
}

/** Per-item votes of the latest round, as each verifier reports them (VERIFIER_ITEM events). */
function liveVotes(events) {
  const items = events.filter((e) => e.type === "VERIFIER_ITEM" && e.payload);
  const round = Math.max(0, ...items.map((e) => e.payload.round ?? 0));
  const votes = new Map();
  for (const e of items.filter((x) => (x.payload.round ?? 0) === round)) {
    const key = `${e.payload.m}.${e.payload.i}`;
    if (!votes.has(key)) votes.set(key, []);
    votes.get(key).push({ verifier: e.actor, verdict: e.payload.verdict, injection: e.payload.injection === true, summary: e.payload.summary });
  }
  return votes;
}

function schedule(id, job, run) {
  clearTimeout(timer);
  const busy = job.status === "VERIFYING" || run?.stage === "running";
  timer = setTimeout(() => {
    if (location.pathname === `/app/jobs/${id}`) detailView(id, { poll: true }).catch(() => schedule(id, job, run));
  }, busy ? 1200 : 3000);
}

function stepper(status) {
  const i = STEPS.indexOf(status);
  const side = i < 0 ? el("p", { class: "muted" }, `This job left the normal path: ${status}.`) : null;
  return el("div", {},
    el("ol", { class: "stepper", "aria-label": "Progress" }, STEPS.map((s, k) => el("li", { class: k < i ? "done" : k === i ? "now" : "" }, STEP_LABEL[s]))),
    side,
  );
}

function demoRunPanel(id, run) {
  const kids = [el("h2", {}, `Demo run: ${run.site} delivery`)];
  if (run.stage === "awaiting_approval" && safeHref(run.approve_url)) {
    kids.push(
      el("p", {}, "The buyer agent is waiting for a person to approve the payment in PayPal, once. Log in with the sandbox buyer account, approve, then come back."),
      el("div", { class: "row" },
        el("a", { class: "btn primary", href: safeHref(run.approve_url), target: "_blank", rel: "noopener noreferrer" }, "Approve in PayPal"),
        el("button", { onclick: async () => { await api("POST", `/demo/runs/${id}/approved`); detailView(id); } }, "I approved it"),
      ),
    );
  } else if (run.stage === "error") {
    kids.push(el("p", { class: "form-error" }, `The run stopped: ${run.error}`));
  } else {
    kids.push(el("p", { class: "muted" }, run.stage === "done" ? "Finished." : "The agents are working…"));
  }
  kids.push(el("pre", { class: "log" }, run.log.slice(-40).join("\n")));
  return el("section", { class: "panel action gap-top" }, kids);
}

/** Buttons for the next step, for whoever is signed in. */
function actionPanel(job, role) {
  const kids = [];
  const err = el("p", { class: "form-error" });
  const act = (label, fn, cls = "primary") => {
    const b = el("button", { class: cls, onclick: async () => {
      b.disabled = true;
      err.textContent = "";
      try {
        await fn();
        await detailView(job.id);
      } catch (e) {
        err.textContent = e.message;
        b.disabled = false;
      }
    } }, label);
    return b;
  };
  const post = (path, body = {}) => api("POST", `/jobs/${job.id}${path}`, body);

  if (!state.me) {
    kids.push(el("p", {}, "Sign in as the client or the worker of this job to act on it. ", el("button", { class: "small", onclick: () => showSignIn() }, "Sign in")));
  } else if (!role) {
    kids.push(el("p", { class: "muted" }, "You are not a party to this job, so you can watch but not act."));
  } else {
    const s = job.status;
    const mineAccepted = job.acceptances?.[role];
    if (s === "CHECKLIST_PROPOSED") {
      if (mineAccepted) kids.push(el("p", {}, `You accepted contract ${job.checklist_hash.slice(0, 12)}…. Waiting for the ${role === "client" ? "worker" : "client"}.`));
      else kids.push(el("p", {}, "Review the contract below. Accepting signs off on exactly this version (its SHA-256 fingerprint):"), el("p", {}, el("code", {}, job.checklist_hash)), act("Accept this contract", () => post("/accept", { checklist_hash: job.checklist_hash })));
    }
    if (role === "client" && (s === "AGREED" || s === "FUNDING_PENDING")) {
      kids.push(el("p", {}, "The contract is frozen. Lock the budget: PayPal creates an order carrying the contract fingerprint, you approve it once, and PayPal holds the money."));
      const approveSlot = el("div", { class: "row dialog" });
      kids.push(act(s === "AGREED" ? "Lock funds with PayPal" : "Get the PayPal approval link again", async () => {
        const r = await post("/lock");
        const href = safeHref(r.approve_url);
        try { sessionStorage.setItem(`kept.approve.${job.id}`, href ?? ""); } catch { /* ignore */ }
      }));
      const saved = (() => { try { return sessionStorage.getItem(`kept.approve.${job.id}`); } catch { return null; } })();
      if (s === "FUNDING_PENDING") {
        if (saved) approveSlot.append(el("a", { class: "btn", href: saved, target: "_blank", rel: "noopener noreferrer" }, "Approve in PayPal"));
        approveSlot.append(act("I approved it — confirm", () => post("/confirm")));
        kids.push(approveSlot);
      }
    }
    if (role === "worker" && s === "FUNDED") {
      const url = el("input", { type: "url", placeholder: "https://…", value: `${location.origin}/demo/sites/good/` });
      kids.push(
        el("p", {}, "PayPal is holding the money. Deliver: submit the URL of the finished work."),
        el("label", {}, "Deliverable URL"), url,
        el("div", { class: "row dialog" },
          act("Submit delivery", () => post("/submit", { deliverable_url: url.value })),
          ...["good", "flawed", "sneaky"].map((site) => el("button", { class: "small", onclick: () => { url.value = `${location.origin}/demo/sites/${site}/`; } }, `use demo: ${site}`)),
        ),
      );
    }
    if (s === "DELIVERED") kids.push(el("p", {}, "Delivered. Start the verifier quorum: three verifiers in different browsers check every item; two must agree."), act("Run the verifiers", () => post("/verify")));
    if (s === "VERIFYING") kids.push(el("p", {}, "The verifiers are checking the delivery. Each verifier's vote appears under its item as it lands; the final verdict follows once two agree and the quorum certificate is signed."));
    const open = job.milestones.flatMap((m) => m.items.filter((it) => it.verdict === "needs_client" && !it.client_decision));
    if (s === "VERIFIED") {
      if (open.length) kids.push(el("p", {}, role === "client" ? `${open.length} item(s) need your decision (see the contract below) before settling.` : `Waiting for the client to decide ${open.length} item(s).`));
      else kids.push(el("p", {}, "Verified. Settling re-checks the contract fingerprint and every verifier signature, then releases passed milestones and refunds failed ones."), act("Settle on PayPal", () => post("/settle")));
    }
    if (s === "SETTLED") kids.push(el("p", {}, "Settled. The Proof Receipt below proves why each milestone was paid or refunded."));
    if (role === "client" && ["DRAFT", "CHECKLIST_PROPOSED", "AGREED", "FUNDING_PENDING"].includes(s)) kids.push(el("div", { class: "dialog" }, act("Cancel job", () => post("/cancel", {}), "danger small")));
  }
  if (!kids.length) return null;
  return el("section", { class: "panel action gap-top" }, el("h2", {}, role ? `Next step (you are the ${role})` : "Next step"), kids, err);
}

function moneyPanel(job, ledger) {
  if (!ledger) return el("section", { class: "panel" }, el("h2", {}, "Money"), el("p", { class: "muted" }, "No money view."));
  const cur = ledger.currency;
  return el("section", { class: "panel", "data-panel": "money" },
    el("h2", { class: "flush" }, "Money"),
    el("div", { class: "summary flush" },
      stat("Held by PayPal", money(ledger.held_cents, cur)),
      stat("Released to worker", money(ledger.released_cents, cur)),
      stat("Refunded to client", money(ledger.refunded_cents, cur)),
    ),
    el("dl", { class: "facts gap-top" },
      el("dt", {}, "PayPal order"), el("dd", { class: "mono" }, ledger.paypal_order_id ?? "—"),
      el("dt", {}, "Contract on order"), el("dd", { class: "mono" }, job.checklist_frozen ? `custom_id = ${job.checklist_hash}` : "— (not agreed yet)"),
    ),
    el("div", { class: "table-wrap" }, el("table", { class: "narrow" },
      el("thead", {}, el("tr", {}, el("th", {}, "Milestone"), el("th", {}, "Gross"), el("th", {}, "Status"), el("th", {}, "PayPal ID"))),
      el("tbody", {}, ledger.milestones.map((m) => el("tr", {},
        el("td", {}, m.title), el("td", {}, money(m.amount_cents, cur)), el("td", {}, badge(m.status)),
        el("td", { class: "mono fine" }, m.paypal.release_id ?? m.paypal.refund_id ?? m.paypal.capture_id ?? "—"),
      ))),
    )),
    el("p", { class: "muted fine" }, "Amounts are gross. PayPal deducts its fee on the worker's side; fee and net appear here once the PayPal rail reports them."),
  );
}

function stat(label, value) {
  return el("div", { class: "stat" }, el("span", { class: "muted" }, label), el("b", {}, value));
}

function proofPanel(job) {
  const v = job.verification;
  const kids = [el("h2", { class: "flush" }, "Proof")];
  if (!v) {
    kids.push(el("p", { class: "muted" }, "No verification yet. Once the work is delivered, three verifiers check it independently."));
  } else {
    kids.push(el("p", {}, `Verification round ${v.round}: `, v.certificate_hash ? el("span", {}, "quorum certificate ", el("code", {}, `${v.certificate_hash.slice(0, 16)}…`)) : el("span", { class: "muted" }, "in progress")));
    kids.push(el("ul", { class: "items" }, v.runs.map((r) => el("li", {},
      el("div", {}, el("b", {}, r.verifier_id), el("div", { class: "kind" }, r.browser ?? "starting…", r.error ? ` — ${r.error}` : "")),
      el("div", {}, badge(r.status === "done" ? "pass" : r.status === "error" ? "fail" : "pending", r.status), safeHref(r.replay_url ?? "") ? el("a", { href: safeHref(r.replay_url), target: "_blank", rel: "noopener noreferrer", class: "replay" }, "replay") : null),
    ))));
    if (v.certificate_hash) {
      kids.push(el("div", { class: "row dialog" },
        el("a", { class: "btn primary", href: `/jobs/${job.id}/report` }, "Open the evidence report"),
        el("a", { class: "btn", href: `/jobs/${job.id}/receipt?download=1` }, "Download Proof Receipt"),
      ));
      kids.push(el("p", { class: "muted fine" }, "Check the receipt yourself, offline: ", el("code", {}, "node tools/verify-receipt.mjs kept-receipt.json")));
    }
  }
  return el("section", { class: "panel", "data-panel": "proof" }, kids);
}

function contractPanel(job, role, votes = new Map()) {
  if (!job.checklist) return el("section", { class: "panel gap-top" }, el("h2", {}, "Contract"), el("p", { class: "muted" }, "No contract proposed yet."));
  const acc = job.acceptances ?? {};
  return el("section", { "data-panel": "contract" },
    el("h2", {}, "Contract"),
    el("p", {}, job.checklist_frozen ? "Frozen. Fingerprint " : "Proposed. Fingerprint ", el("code", {}, job.checklist_hash), " · client ", acc.client ? el("span", { class: "check" }, "accepted") : "not yet", " · worker ", acc.worker ? el("span", { class: "check" }, "accepted") : "not yet"),
    el("p", { class: "muted" }, `Verifier quorum: ${job.checklist.quorum.k} of ${job.checklist.quorum.n} must agree (${job.checklist.quorum.verifiers.map((v) => v.id).join(", ")}).`),
    job.milestones.map((ms) => el("section", { class: "panel milestone", "data-milestone": ms.m },
      el("div", { class: "ms-head" },
        el("h3", {}, `${ms.m + 1}. ${ms.title}`),
        el("div", { class: "row" }, el("b", {}, money(ms.amount_cents, job.currency)), ms.outcome ? badge(ms.outcome) : null, ms.status !== "pending" ? badge(ms.status) : null),
      ),
      el("ul", { class: "items" }, ms.items.map((it) => itemRow(job, ms, it, role, votes.get(`${ms.m}.${it.i}`) ?? []))),
    )),
  );
}

function itemRow(job, ms, it, role, votes = []) {
  const verdict = it.client_decision ? badge(it.client_decision.decision, `client: ${it.client_decision.decision}`) : it.verdict ? badge(it.verdict, VERDICT[it.verdict] ?? it.verdict) : job.status === "VERIFYING" ? badge("pending", "checking…") : null;
  const reason = it.verdict_reason && !it.client_decision ? el("div", { class: "kind" }, REASON[it.verdict_reason] ?? it.verdict_reason) : null;
  let decide = null;
  if (role === "client" && job.status === "VERIFIED" && it.verdict === "needs_client" && !it.client_decision) {
    const note = el("input", { type: "text", placeholder: "Note (optional)", class: "note" });
    const send = (decision) => async () => {
      try {
        await api("POST", `/jobs/${job.id}/items/${ms.m}/${it.i}/decision`, { decision, note: note.value || undefined });
        detailView(job.id);
      } catch (e) {
        alert(e.message);
      }
    };
    decide = el("div", { class: "decide" }, note, el("button", { class: "small primary", onclick: send("approve") }, "Approve"), el("button", { class: "small danger", onclick: send("reject") }, "Reject"),
      el("a", { href: `/jobs/${job.id}/report`, class: "small" }, "see every verifier's evidence"));
  }
  const voteChips = votes.length
    ? el("div", { class: "votes" }, votes.map((v) => el("span", { class: `badge v-${v.injection ? "fail" : v.verdict}`, title: v.summary ?? "" }, `${v.verifier.replace("verifier-", "")}: ${v.injection ? "injection" : VERDICT[v.verdict] ?? v.verdict}`)))
    : null;
  return el("li", { "data-item": `${ms.m}.${it.i}` },
    el("div", {}, el("div", {}, it.description), el("div", { class: "kind" }, KIND[it.check_type] ?? it.check_type), voteChips),
    el("div", { class: "verdict" }, verdict, reason),
    decide,
  );
}

const EVENT = {
  JOB_POSTED: "Job posted", CHECKLIST_REVISED: "Contract revised", CHECKLIST_ACCEPTED: "Contract accepted", STATUS_CHANGED: "Status",
  VERIFICATION_REQUESTED: "Verification requested", INJECTION_DETECTED: "Prompt-injection attempt caught", INJECTION_SUSPECTED: "Lone injection flag (outvoted)",
  CLIENT_DECISION: "Client decided an item", MILESTONE_RELEASED: "Milestone released", MILESTONE_REFUNDED: "Milestone refunded",
  SETTLEMENT_STARTED: "Settlement started", SETTLEMENT_REFUSED: "Settlement refused", VERIFICATION_ERROR: "Verification error",
};

function timelinePanel(events) {
  return el("section", {},
    el("h2", {}, "Timeline"),
    el("ol", { class: "timeline panel" }, events.filter((e) => e.type !== "VERIFIER_ITEM").reverse().map((e) => el("li", {},
      el("time", {}, when(e.at)),
      el("span", {},
        e.type === "STATUS_CHANGED" && e.payload ? `${STEP_LABEL[e.payload.from] ?? e.payload.from} → ${STEP_LABEL[e.payload.to] ?? e.payload.to}` : (EVENT[e.type] ?? e.type),
        el("span", { class: "muted" }, ` · ${e.actor}`),
      ),
    ))),
  );
}

// ---------- start ----------

(async () => {
  try {
    state.health = await api("GET", "/health");
  } catch {
    state.health = null;
  }
  renderBanner();
  await loadMe();
  await route();
})().catch((e) => app.replaceChildren(el("p", { class: "form-error" }, `Could not load: ${e.message}`)));
