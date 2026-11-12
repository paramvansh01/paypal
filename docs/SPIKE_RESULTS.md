# PayPal spike results

Evidence for the rail decision (CLAUDE.md T1.2–T1.6). Each run of `npm run spike:rail -- --rail <name> --write` appends a section below. Secrets are never written here.

Status: no sandbox run yet (waiting for H2–H3). The rails are implemented in `src/rails/paypal.ts` against PayPal's published Orders v2 / Payments v2 schemas and tested against an in-memory fake (`tests/paypal-rails.test.ts`).

Still to verify in the sandbox:
- auth_capture: multiple partial captures with `final_capture: false`, then void of the remainder.
- delayed_disbursement: seller onboarding with DELAY_FUNDS_DISBURSEMENT, the `referenced-payouts-items` response shape, the `PayPal-Auth-Assertion` encoding (we send base64url), refunding a held capture, and whether the worker balance visibly moves.

## 2026-11-12T11:54:44.355Z — rail auth_capture (spike-rail.ts)

- Order 70988750H3491002G created (custom_id = contract hash).
- Confirmed: captures [], authorization 15V04978B9632670D.
- Milestone 1: release → 2V648948448496245
- Milestone 2: release → 1TD502029F446393A
- Milestone 3: refund → (nothing to move)
- Milestone 4: release → 1L656607B3721045F
- Finalize → 15V04978B9632670D
- PayPal reports: order COMPLETED, held 0¢, released 300¢, refunded 100¢.
- NOW CHECK BY HAND: buyer and worker sandbox balances (expected: worker +$3.00 gross minus fees, buyer charged $3.00 net).
- Read back independently from PayPal (`GET /v2/payments/...`): authorization 15V04978B9632670D is VOIDED (original $4.00); captures 2V648948448496245, 1TD502029F446393A, 1L656607B3721045F are each COMPLETED for $1.00, PayPal fee $0.54, net $0.46 to the seller. So partial captures with `final_capture: false` and voiding the remainder both work in sandbox. `note_to_payer` is not echoed back on GET capture.
- Accounts: US personal buyer, US business seller (a Platform app). Indian (IN) sandbox accounts failed at approval with "This seller doesn't accept payments in your currency", so use US accounts.
