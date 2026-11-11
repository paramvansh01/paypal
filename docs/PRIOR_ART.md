# Prior art and the novelty claim (TQ.11)

Searched 2026-11-11 (web search; vendor pages and repositories, not independent audits). The goal: say exactly what is new about Kept, and nothing more.

## What already exists

**AI-verified escrow — exists, on crypto rails.** Several projects release escrowed funds when an AI or automated check passes the deliverable:

- [Surety](https://github.com/Marko-AI-Dev/surety): a hackathon prototype on the XRP Ledger (testnet only) that releases escrow only when the work passes checks, and refunds after expiry.
- [Kustodia](https://cointelegraph.com/press-releases/kustodia-launches-the-missing-escrow-layer-for-ai-agents-and-x402-payments): MCP tools for agent escrow on x402 payments (a June 2026 press release).
- Underwrite ([DEV post](https://dev.to/workflowbuilderai/im-an-ai-agent-and-i-built-an-escrow-protocol-for-agent-to-agent-work-1dhm)): combines deterministic checks with an evaluator's rubric and a confidence threshold, and hands uncertain cases to a human.
- [Synmerco](https://dev.to/innerozma/how-my-ai-agent-earned-usdc-on-synmerco-5-released-escrows-73-gross-no-human-in-the-loop-mpn), [SwarmSync](https://swarmsync.ai/agent-escrow-payments), [Locus](https://paywithlocus.com/use-cases/escrow-for-ai-agents).
- [FluxPay](https://flux-paydocs.vercel.app/), [Aqoryn](https://guna-thota.github.io/aqoryn), [Arc's escrow sample](https://docs.arc.io/build/sample-apps/arc-escrow), [Trustless Work](https://docs.trustlesswork.com/trustless-work/use-cases-by-indutry/milestone-based-freelance-and-contract-work).

Everything we found with automated AI release runs on stablecoins or smart contracts. Each uses a single judge, a confidence threshold, or a human approver.

**Card and wallet rails.** Stripe's manual-capture PaymentIntent plus a transfer is a known do-it-yourself hold-then-release pattern. The developer writes their own check. We found no PayPal or Stripe product or sample that releases or refunds per milestone based on automated verification.

**Agent payment protocols.** AP2, x402 and ACP cover authorization and settlement (who approved what spend, and how money moves). They do not decide whether delivered work met a contract, and analyses note they leave dispute resolution open ([blindpay comparison](https://blindpay.com/resources/more/agent-payment-protocols-compared), [AP2 analysis](https://dev.to/aicryptosystems/google-ap2-the-mandate-is-not-the-payment-1m04)).

**Quorums, signatures and Merkle roots.**
- [Dropbear](https://arxiv.org/pdf/2205.15757) uses Byzantine agreement over ML inference results, with a Merkle root signed by a coordinator.
- [QuorumProof](https://github.com/simongonzalezdc/quorumproof) is a 3-agent quorum with signed certificates that gate an on-chain action (hackathon project).
- Certificate Transparency (RFC 6962), whose Merkle construction we use, is long-established.

Kept's quorum and Merkle constructions are standard techniques, applied rather than invented.

**Canary tokens against prompt injection.** Canary tokens are a known, cheap detector, used in Rebuff and many guardrail products ([overview](https://klu.ai/glossary/prompt-injection-canary-tokens), [Arcjet](https://arcjet.com/learn/how-platforms-detect-prompt-injection-runtime)). The literature also states the limit:
- A canary catches output that was not produced under our instructions.
- It does not catch an injection that persuades the judge while the judge still copies the canary.
- An LLM judge reading attacker text is exposed to the attack it is judging ([CourtGuard](https://arxiv.org/pdf/2510.19844)).

Kept's answer is defence in depth:
- deterministic checks decide everything they can;
- a deterministic DOM tripwire flags hidden instructions before any model reads the page;
- the canary and the judge's own `injection_suspected` flag are a second net;
- a quorum of different models in different browsers means one fooled judge cannot pay out alone.

## What we are allowed to say

The novelty sentence (use these words, or weaker ones):

> **"AI-verified escrow exists, but on crypto rails, with one judge or a human approver. We found no other system that pays on PayPal only after a k-of-n quorum of independent verifiers — each in its own browser engine with its own AI judge, guarded by prompt-injection tripwires — signs Merkle-committed evidence, and that hands everyone a receipt they can verify offline."**

Short form for the pitch: **"a new payment primitive: conditional money on PayPal, released by a verifier quorum, with a receipt anyone can check."**

Do not say:
- "first", "nobody else", "the only";
- "AI escrow is new" (it is not);
- "decentralised", "blockchain", "trustless", "zero-knowledge";
- "eliminates prompt injection" (say "reduces").

Do say: "the combination is new to our knowledge", "on PayPal, not crypto", "every claim maps to code and a test".

## Honest limits to state if asked

- In the demo, all verifiers run on our server. The protocol allows independent operators, but we do not run a network of them.
- Canary checks catch hijacked output, not persuaded output; the quorum and the deterministic checks carry the weight.
- Correlated failures are possible: three judges from one model family could share a blind spot. Engine diversity (Chromium, WebKit) and model diversity (Opus, Sonnet, Haiku) reduce this but do not remove it.
