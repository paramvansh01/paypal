# PayPal spike results

Evidence for the rail decision (CLAUDE.md T1.2–T1.6). Each run of `npm run spike:rail -- --rail <name> --write` appends a section below. Secrets are never written here.

Status: no sandbox run yet (waiting for H2–H3). The rails are implemented in `src/rails/paypal.ts` against PayPal's published Orders v2 / Payments v2 schemas and tested against an in-memory fake (`tests/paypal-rails.test.ts`).

Still to verify in the sandbox:
- auth_capture: multiple partial captures with `final_capture: false`, then void of the remainder.
- delayed_disbursement: seller onboarding with DELAY_FUNDS_DISBURSEMENT, the `referenced-payouts-items` response shape, the `PayPal-Auth-Assertion` encoding (we send base64url), refunding a held capture, and whether the worker balance visibly moves.
