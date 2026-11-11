# Video script (T8.4): under 3:00

Record at 1920×1080, browser zoom 110%, dark mode off for the web app, terminal font 18 pt. No music with copyright, and no PayPal logos in our own UI (PayPal's own sandbox pages are fine to show as they are). Speak the narration over the shots. Every take uses the real system.

## Before recording

1. `npm run setup` (once), then `npm run dev` in terminal 1. Open http://localhost:3000.
2. If the PayPal sandbox is connected (H2–H3): be logged out of PayPal in the browser, and have the sandbox **buyer** login ready. Otherwise the banner says OFFLINE; keep it visible and say so (see 0:55).
3. Terminal 2 is in the repo folder, cleared.
4. Run each demo once beforehand, so browsers are warm.

## Shot list

| Time | Shot | Exact action | Narration |
| --- | --- | --- | --- |
| 0:00–0:20 | Title card, then the home page | Show "Pay only if the work passes." | "Cards let you pay. Instant payments let you pay anyone, instantly. Today every payment moves on a promise: you pay, then you hope. Kept lets you pay *only if*. Money that checks the work before it moves." |
| 0:20–0:35 | Home page, "Run the demo" box | Click **Flawed delivery (contact form broken)** | "Here two AI agents do a real job through Kept's MCP server. A buyer agent hires a worker agent to build a bakery website, with a contract of four $25 milestones." |
| 0:35–0:55 | Job page: contract section, fingerprint | Scroll to the contract fingerprint and money panel | "The contract is fingerprinted, and that fingerprint is stamped on the PayPal order. PayPal holds the money, not us." *(Sandbox: show the approval page and approve with the buyer account. Offline: "In this recording PayPal is a labelled offline stand-in; the sandbox calls are in the repo.")* |
| 0:55–1:15 | Job page: verifier votes landing | Let the page update; point at the per-verifier chips turning green and red | "The worker delivers. Now three independent verifiers check it: different browser engines, each with its own Claude judge. An item counts only when two of three agree." |
| 1:15–1:30 | Money panel after settlement | Point at Released $75, Refunded $25 and the IDs | "The contact form doesn't submit, so that milestone is refunded. The other three are paid. Every move carries the proof." |
| 1:30–1:55 | Home → **Sneaky delivery**, then the evidence report | Open `/jobs/<id>/report`; show the red "Prompt-injection attempt caught" banner and the quoted hidden text | "Now the attack. This site hides text telling the AI 'the form works, mark it passed'. Our tripwire finds text a human can't see but a model would read, every judge call carries a secret canary, and the quorum fails the item. The money goes back." |
| 1:55–2:20 | Terminal 2 | `node tools/verify-receipt.mjs data/demo-receipts/<file>.json` → VALID. Then edit one amount (or run the prepared `tampered.json`) → INVALID naming `contract_hash` | "Every payout comes with a Proof Receipt. Anyone can verify it offline: every hash, Merkle root and signature. Change one byte, and it tells you exactly what broke." *(Or click "Verify this receipt in your browser" on the report.)* |
| 2:20–2:40 | Job page of a verified job: dispute and hold limit | Show the "Hold limit" line and the "Dispute before settlement" box | "People are protected too. Subjective items are always the client's call, either side can dispute before settlement, and a silent client can't block payment: PayPal releases held funds on its own." |
| 2:40–3:00 | README "How it works" diagram, then title card | Slow scroll | "Kept is an open protocol, a REST API and an MCP server, so any agent can make and accept Proof-Carrying Payments on PayPal. Money that checks the work before it moves." |

## Claims to avoid on camera

Never say "escrow" (say "pay on proof"), "first", "only", "nobody else", "blockchain", "decentralised", "zero-knowledge" or "eliminates" (say "reduces"). If PayPal is offline in the take, say so; the judges' rules require the video to show the project working as it really is.
