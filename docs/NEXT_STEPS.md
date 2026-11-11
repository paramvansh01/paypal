# What is left, and how to do it

Paste the block below into a new Claude Code session opened in this repo (or hand it to a teammate). Everything that needs no keys is already built and tested. Each remaining step says which human task (H#, CLAUDE.md section 5) it waits on.

```text
You are continuing the Kept hackathon project (repo: https://github.com/paramvansh01/paypal, branch main).
CLAUDE.md is the source of truth: run its Session Start Protocol first (pull, read Live State and the
last three Session Log entries, npm install, npx playwright install chromium webkit, npm run doctor,
npm run check, take the lock). Everything that needs no keys is already built and tested (629 tests).
What is left needs accounts, keys or a person. Work through it in this order, one task at a time,
committing and pushing after each, and keep CLAUDE.md (Live State, task marks, Decision Log,
Session Log) accurate.

1. PayPal sandbox proof (needs human tasks H2–H3 first)
   - The human creates a PayPal Developer sandbox REST app (Platform/Marketplace type), one personal
     (buyer) and two business (worker) sandbox accounts, and puts PAYPAL_CLIENT_ID,
     PAYPAL_CLIENT_SECRET, DEMO_CLIENT_EMAIL, DEMO_WORKER_EMAIL (and, for the delayed rail,
     PAYPAL_PARTNER_ATTRIBUTION_ID, PAYPAL_PARTNER_MERCHANT_ID, DEMO_WORKER_MERCHANT_ID) in .env.
     Never type credentials into websites yourself.
   - T1.1: run `npm run spike:token` and confirm a real token comes back. Mark T1.1 [x].
   - T1.2: run `npm run spike:rail -- --rail auth_capture --write`. The human approves at the printed
     link with the sandbox buyer account. Then the human checks buyer and worker sandbox balances.
     If anything fails, fix src/rails/paypal.ts against the real responses (PayPal's OpenAPI schemas
     are at developer.paypal.com/api/<orders|payments|webhooks>/v<n>/schema.json) and record the
     real request/response samples (no secrets) in docs/SPIKE_RESULTS.md.
   - T1.3–T1.5 (only if the team wants the preferred rail): onboard the worker with
     DELAY_FUNDS_DISBURSEMENT, then `npm run spike:rail -- --rail delayed_disbursement --write`.
     Things still unverified: the referenced-payouts-items response shape, the PayPal-Auth-Assertion
     encoding (we send base64url), refunding a held capture, and whether the worker balance moves.
     Time box ~6 hours total.
   - T1.6: decide the rail by the rule in CLAUDE.md T1.6, log it in the Decision Log, set
     "Payment rail" in Live State and PAYMENT_RAIL in .env and render.yaml.
   - Then: mark T2.3/T2.4 done to the level proven; TQ.9 (certificate hash on captures/refunds is
     already sent; confirm PayPal shows it); T2.7 (decide whether status() should correct local
     state, using real responses); T5.3 (show PayPal fee and net from real capture data);
     T4.5: `npm run demo -- --site all --runs 3` must pass on the real rail (it pauses for approval);
     T2.8 `npm run e2e` is covered by the demo plus balance checks — note that in the log.

2. AI live runs (needs H4: ANTHROPIC_API_KEY, LLM_MODEL=claude-opus-5-5, KERNEL_API_KEY)
   - T3.2: generate contracts for five varied briefs (POST /checklists/generate or MCP post_job
     without a checklist); all must validate. Record them with LLM_RECORD_DIR so tests can replay.
   - T3.6: run a job whose contract has an llm_judgement item on demo/sites/good and sneaky; the
     sneaky one must be flagged. Check that verifier-a uses KERNEL when the deliverable is public
     (on the hosted URL) and that replays appear in the report.
   - Rerun `npm run doctor` until every line passes.

3. Real MCP client check (T4.2)
   - The human re-logs into Claude Code (`claude` then /login). Then follow the README "Connect an AI
     agent" steps for both HTTP and stdio, drive one full job from a real client, and mark T4.2 [x].

4. Deploy (needs H7: Render account connected to the repo)
   - T7.1/T7.2: create the service from render.yaml (Docker on Playwright's image). Set
     VERIFIER_KEYS_JSON from `npm run keys:export` (secret: paste only into Render), the PayPal and
     AI keys, DEMO_* emails. Confirm /health shows money "paypal_sandbox". Register the PayPal
     webhook for <hosted URL>/paypal/webhook and set PAYPAL_WEBHOOK_ID.
     `npm run demo -- --base <hosted URL>` must work. Put the URL in Live State and the README.
   - T7.3: add on-page instructions for the PayPal approval step; agree with the human how to share
     the sandbox buyer login with judges safely.

5. Submission (needs H8, H9, H10, H11)
   - H8/H9: the human pastes the official rules section 8 (KERNEL, Render, Postman prize
     requirements), the judging criteria, the deadline and team names into CLAUDE.md sections 0
     and 4. Then T7.5: meet each sponsor requirement.
   - T8.3: re-map docs/SUBMISSION.md to the official criteria; fill hosted URL, video link, team and
     the honest PayPal status.
   - T8.6 / H10: the human records the video from docs/VIDEO_SCRIPT.md (under 3:00, public YouTube,
     no copyrighted music). Before recording, check every claim against docs/PRIOR_ART.md
     (never say escrow, first, only, decentralised, eliminates).
   - Final pass: check every rule in CLAUDE.md section 4 line by line, update the README with the
     hosted URL and video, then the human submits (H11).

Optional if time remains (COULD): T5.5 visual polish for 1080p, S1–S4 stretch goals.
Remember the cut-line rule: 48 hours before the deadline, stop feature work and finish 4 and 5.
When done or stopping, run the Session End Protocol in CLAUDE.md.
```
