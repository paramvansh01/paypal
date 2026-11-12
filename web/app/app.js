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
/** Replace the page body, skipping empty slots (null/false) instead of printing them. */
const put = (...kids) => app.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));

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
  put(
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
  put(
    el("section", { class: "hero" },
      el("p", { class: "eyebrow" }, "Proof-Carrying Payments, settled on PayPal"),
      el("h1", {}, "Pay only if the work passes."),
      el("p", { class: "lede" }, "A client and a worker agree a machine-checkable contract. PayPal holds the money. Three independent verifiers check the delivery, sign what they saw, and each milestone is released only when two of them agree it passed. Every payout comes with a Proof Receipt anyone can verify."),
      el("div", { class: "row" },
        state.me ? el("a", { class: "btn primary", href: "/app/new", "data-nav": true }, "Post a job") : el("button", { class: "primary", onclick: () => showSignIn() }, "Sign in to post a job"),
        state.me ? el("a", { class: "btn", href: mine ? "/" : "/?mine", "data-nav": true }, mine ? "All jobs" : "My jobs") : null,
      ),
      el("ol", { class: "how" },
        howStep("1", "Agree", "The brief becomes a contract. Its SHA-256 fingerprint is stamped on the PayPal order."),
        howStep("2", "Hold", "The client approves once. PayPal holds the funds, not Kept."),
        howStep("3", "Verify", "Three verifiers in different browsers check every item, watch for prompt injection and sign their evidence."),
        howStep("4", "Settle", "Each milestone the quorum passed is paid to the worker; each one that failed goes back to the client."),
      ),
    ),
    demoBox,
    el("h2", {}, mine ? "My jobs" : "Jobs"),
    table,
  );
  timer = setTimeout(() => location.pathname === "/" && listView().catch(() => {}), 4000);
}

function howStep(n, title, text) {
  return el("li", {}, el("span", { class: "how-n" }, n), el("b", {}, title), el("span", {}, text));
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
  const card = (site, title, text, expect, cls) => {
    const b = el("button", { class: `demo-card ${cls}`, onclick: () => start(site, b) },
      el("b", {}, title), el("span", {}, text), el("span", { class: "expect" }, expect));
    return b;
  };
  return el("section", { class: "panel demo" },
    el("h2", { class: "flush" }, "Run the demo"),
    el("p", { class: "muted" }, "Two AI agents do a whole job over Kept's MCP server: the buyer posts a bakery-website job worth 4 × $25 and pays, the worker delivers, the verifier quorum checks it, and settlement pays or refunds each milestone."),
    el("div", { class: "demo-cards" },
      card("good", "Good delivery", "Everything in the contract works.", "4 of 4 released", "ok"),
      card("flawed", "Flawed delivery", "The contact form does not submit.", "3 released · 1 refunded", "mixed"),
      card("sneaky", "Sneaky delivery", "Same broken form, plus hidden text telling the AI judge it works.", "Injection caught · 1 refunded", "bad"),
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
  put(
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
    put(el("h1", {}, "Not found"), el("p", { class: "muted" }, `There is no job ${id}.`), el("a", { href: "/", "data-nav": true }, "← All jobs"));
    return;
  }
  const pp = paypalFees(id, ledger);
  const snapshot = JSON.stringify([job, ledger, ev, run, state.me?.party_id, pp]);
  const typing = document.activeElement && ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName) && app.contains(document.activeElement);
  if (opts.poll && (snapshot === lastSnapshot || typing)) return schedule(id, job, run);
  lastSnapshot = snapshot;
  document.title = `${job.title} · Kept`;

  const role = state.me ? (state.me.party_id === job.client_id ? "client" : state.me.party_id === job.worker_id ? "worker" : null) : null;
  put(
    el("p", {}, el("a", { href: "/", "data-nav": true }, "← All jobs")),
    el("div", { class: "head" },
      el("div", {},
        el("h1", {}, job.title),
        el("p", { class: "muted" }, job.brief),
      ),
      el("div", { class: "row" }, badge(job.status.toLowerCase(), STEP_LABEL[job.status] ?? job.status), el("b", {}, money(job.total_cents, job.currency))),
    ),
    stepper(job.status),
    injectionAlert(ev.events),
    run && run.stage !== "done" ? demoRunPanel(id, run) : null,
    role ? actionPanel(job, role) : null,
    moneyPanel(job, ledger),
    proofPanel(job),
    run && run.stage === "done" ? demoRunPanel(id, run) : null,
    role ? null : actionPanel(job, role),
    contractPanel(job, role, liveVotes(ev.events)),
    timelinePanel(ev.events),
  );
  const log = app.querySelector(".log");
  if (log) log.scrollTop = log.scrollHeight;
  mountLedger(job, ledger, pp);
  schedule(id, job, run);
}

/** The worker's delivery tried to talk the AI verifiers into a pass, and the quorum caught it. */
function injectionAlert(events) {
  const hits = events.filter((e) => e.type === "INJECTION_DETECTED");
  if (!hits.length) return null;
  return el("div", { class: "alert gap-top" },
    el("b", {}, "Prompt-injection attempt caught"),
    el("p", {}, "The delivery hid instructions aimed at the AI verifiers. The tripwire flagged it, the item failed, and its money was not paid out."),
  );
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
    if (s === "VERIFIED") {
      const failed = job.milestones.some((m) => m.outcome === "failed");
      if (role === "worker" && failed && job.resubmissions_left > 0) {
        const url = el("input", { type: "url", value: job.deliverable_url ?? "" });
        kids.push(
          el("p", {}, "A milestone failed. You may fix the work and resubmit once before settlement: the whole contract is checked again."),
          el("label", {}, "Fixed deliverable URL"), url,
          el("div", { class: "row dialog" }, act("Resubmit for a new verification", () => post("/resubmit", { deliverable_url: url.value }), "")),
        );
      }
      const reason = el("input", { type: "text", placeholder: "Why you disagree with the verdicts", class: "note" });
      kids.push(el("details", { class: "dialog" }, el("summary", {}, "Dispute before settlement"),
        el("p", { class: "muted fine" }, "Pauses settlement; the money stays held by PayPal. Only you can withdraw your dispute. Otherwise PayPal's hold limit applies."),
        el("div", { class: "row" }, reason, act("Open a dispute", () => post("/dispute", { reason: reason.value || "No reason given" }), "danger small"))));
    }
    if (s === "DISPUTED") kids.push(el("p", {}, "Disputed: settlement is paused and the money stays held. The evidence report shows every verifier's evidence."), act("Withdraw my dispute", () => post("/dispute/withdraw"), ""));
    if (s === "SETTLED") kids.push(el("p", {}, "Settled. The Proof Receipt below proves why each milestone was paid or refunded."));
    if (role === "client" && ["DRAFT", "CHECKLIST_PROPOSED", "AGREED", "FUNDING_PENDING"].includes(s)) kids.push(el("div", { class: "dialog" }, act("Cancel job", () => post("/cancel", {}), "danger small")));
  }
  if (!kids.length) return null;
  return el("section", { class: "panel action gap-top" }, el("h2", {}, role ? `Next step (you are the ${role})` : "Next step"), kids, err);
}

// ---------- money: flow bar + AG Grid ledger (T5.3) ----------

/**
 * PayPal's own fee and net per capture (GET /jobs/:id/paypal). Fetched only when
 * the money state changes, then cached, so polling the page never polls PayPal.
 */
const paypalCache = new Map();
function paypalFees(id, ledger) {
  if (state.health?.money !== "paypal_sandbox" || !ledger?.paypal_order_id) return null;
  const key = `${ledger.paypal_order_id}|${ledger.status}|${ledger.released_cents}|${ledger.refunded_cents}`;
  const hit = paypalCache.get(id);
  if (hit?.key === key) return hit.data;
  if (!hit?.loading || hit.key !== key) {
    paypalCache.set(id, { key, loading: true, data: hit?.data ?? null });
    api("GET", `/jobs/${id}/paypal`)
      .then((data) => paypalCache.set(id, { key, data }))
      .catch(() => paypalCache.set(id, { key, data: { error: true } }))
      .finally(() => { if (location.pathname === `/app/jobs/${id}`) detailView(id).catch(() => {}); });
  }
  return hit?.data ?? null;
}

function moneyPanel(job, ledger) {
  if (!ledger) return el("section", { class: "panel gap-top" }, el("h2", { class: "flush" }, "Money"), el("p", { class: "muted" }, "No money view."));
  const cur = ledger.currency;
  const total = ledger.total_cents || 1;
  const funded = ledger.held_cents + ledger.released_cents + ledger.refunded_cents;
  const seg = (cls, cents, label) => {
    if (!cents) return null;
    const node = el("span", { class: `seg ${cls}`, title: `${label}: ${money(cents, cur)}` }, cents / total > 0.12 ? money(cents, cur) : "");
    node.style.flexGrow = String(cents); // CSSOM, allowed under the CSP (no inline style attribute)
    return node;
  };
  const unfunded = Math.max(0, ledger.total_cents - funded);
  return el("section", { class: "panel gap-top", "data-panel": "money" },
    el("div", { class: "ms-head" },
      el("h2", { class: "flush" }, "Money"),
      el("span", { class: "muted fine" }, ledger.paypal_order_id ? el("span", {}, "PayPal order ", el("code", {}, ledger.paypal_order_id)) : "No PayPal order yet"),
    ),
    el("div", { class: "flow", role: "img", "aria-label": `Held ${money(ledger.held_cents, cur)}, released ${money(ledger.released_cents, cur)}, refunded ${money(ledger.refunded_cents, cur)}` },
      seg("released", ledger.released_cents, "Released to worker"),
      seg("refunded", ledger.refunded_cents, "Back to client"),
      seg("held", ledger.held_cents, "Held by PayPal"),
      seg("unfunded", unfunded, "Not funded yet"),
    ),
    el("div", { class: "summary money-stats" },
      stat("Held by PayPal", money(ledger.held_cents, cur), "held"),
      stat("Released to worker", money(ledger.released_cents, cur), "released"),
      stat("Back to client", money(ledger.refunded_cents, cur), "refunded"),
    ),
    el("div", { id: "ledger-grid", class: "ledger-grid" }),
    el("p", { class: "muted fine" },
      job.checklist_frozen ? el("span", {}, "Contract fingerprint on the order: ", el("code", {}, `custom_id = ${job.checklist_hash.slice(0, 16)}…`), ". ") : null,
      state.health?.money === "paypal_sandbox" ? "Fee and net are PayPal's own numbers, read back from the PayPal sandbox." : "Fee and net appear when the PayPal sandbox rail is connected.",
    ),
    job.hold ? holdNote(job.hold) : null,
  );
}

let ledgerGrid = null;
const LEDGER_LABEL = { pending: "pending", passed: "passed", failed: "failed", released: "released", refunded: "refunded" };

/** The ledger as an AG Grid table: one row per milestone plus a totals row, from Kept's ledger and PayPal's fee breakdown. */
function mountLedger(job, ledger, pp) {
  ledgerGrid?.destroy();
  ledgerGrid = null;
  const host = document.getElementById("ledger-grid");
  const ag = globalThis.agGrid;
  if (!host || !ledger) return;
  const cur = ledger.currency;
  const captures = new Map((pp?.captures ?? []).map((c) => [c.id, c]));
  const rows = ledger.milestones.map((m) => {
    const id = m.paypal.release_id ?? m.paypal.refund_id ?? m.paypal.capture_id ?? null;
    const cap = id ? captures.get(id) : undefined;
    const released = m.status === "released";
    const refunded = m.status === "refunded";
    return {
      milestone: `${m.m + 1}. ${m.title}`,
      status: m.status,
      gross: m.amount_cents,
      fee: released ? cap?.fee_cents ?? null : null,
      net: released ? cap?.net_cents ?? null : null,
      back: refunded ? m.amount_cents : 0,
      paypal: id ?? "—",
    };
  });
  const sum = (k) => rows.reduce((t, r) => (r[k] == null ? t : t + r[k]), 0);
  const anyFee = rows.some((r) => r.status === "released" && r.fee != null);
  const totals = { milestone: "Total", status: "", gross: sum("gross"), fee: anyFee ? sum("fee") : null, net: anyFee ? sum("net") : null, back: sum("back"), paypal: "" };
  if (!ag?.createGrid) {
    host.replaceChildren(el("p", { class: "muted" }, "The ledger table could not load."));
    return;
  }
  const fmt = (p) => (p.value == null ? "—" : money(p.value, cur));
  const nonce = document.querySelector('meta[name="csp-nonce"]')?.content;
  ag.ModuleRegistry.registerModules([ag.AllCommunityModule]);
  ledgerGrid = ag.createGrid(host, {
    styleNonce: nonce,
    theme: ag.themeQuartz.withParams({
      accentColor: "#0e6f6a", foregroundColor: "#0f1b2d", borderColor: "#e2e7ee", headerBackgroundColor: "#f4f6f9",
      headerTextColor: "#5b6b7f", fontFamily: "inherit", fontSize: 14, rowHeight: 44, headerHeight: 40, wrapperBorderRadius: 12,
      oddRowBackgroundColor: "#fbfcfd",
    }),
    domLayout: "autoHeight",
    suppressCellFocus: true,
    rowData: rows,
    pinnedBottomRowData: [totals],
    defaultColDef: { sortable: true, resizable: true, suppressMovable: true },
    columnDefs: [
      { field: "milestone", headerName: "Milestone", flex: 2, minWidth: 200 },
      { field: "status", headerName: "Status", width: 120, cellRenderer: (p) => (p.value ? badge(p.value, LEDGER_LABEL[p.value] ?? p.value) : "") },
      { field: "gross", headerName: "Gross", width: 110, type: "rightAligned", valueFormatter: fmt },
      { field: "fee", headerName: "PayPal fee", width: 120, type: "rightAligned", valueFormatter: fmt },
      { field: "net", headerName: "Worker net", width: 120, type: "rightAligned", valueFormatter: fmt, cellClass: ["ag-right-aligned-cell", "num-pass"] },
      { field: "back", headerName: "Back to client", width: 135, type: "rightAligned", valueFormatter: (p) => (p.value ? money(p.value, cur) : "—"), cellClass: ["ag-right-aligned-cell", "num-fail"] },
      { field: "paypal", headerName: "PayPal ID", flex: 1, minWidth: 190, cellClass: "mono-cell", tooltipField: "paypal" },
    ],
    getRowClass: (p) => (p.node.rowPinned ? "ledger-total" : undefined),
  });
}

/** T6.1: when PayPal moves the held money on its own, whatever Kept does. */
function holdNote(hold) {
  const ms = new Date(hold.expires_at).getTime() - Date.now();
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const left = ms <= 0 ? "now" : `in ${days} day${days === 1 ? "" : "s"} ${hours} h`;
  return el("p", { class: "hold" }, el("b", {}, `Hold limit: ${left}`), ` (${new Date(hold.expires_at).toLocaleString()}). `, hold.rule);
}

function stat(label, value, tone) {
  return el("div", { class: `stat${tone ? ` stat-${tone}` : ""}` }, el("span", { class: "muted" }, label), el("b", {}, value));
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
  SETTLEMENT_STARTED: "Settlement started", WORK_RESUBMITTED: "Worker resubmitted the work", PAYPAL_WEBHOOK: "PayPal notification (verified)", SETTLEMENT_REFUSED: "Settlement refused", VERIFICATION_ERROR: "Verification error",
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
})().catch((e) => put(el("p", { class: "form-error" }, `Could not load: ${e.message}`)));
