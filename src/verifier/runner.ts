import { canonicalJson, contractItems, type Checklist } from "../core/checklist.js";
import { signAttestation } from "../qaps/attestation.js";
import type { VerifierKey } from "../qaps/keys.js";
import { evidenceRoot, type LeafRecord } from "../qaps/leaf.js";
import { PROTOCOL } from "../qaps/protocol.js";
import type { VerifierReport } from "../qaps/quorum.js";
import type { BrowserProvider } from "./browser.js";
import { runCheck, type CheckResult } from "./checks/index.js";
import type { EvidenceStore } from "./evidence-store.js";
import { scanPage, type TripwireReport } from "./tripwire.js";
import type { NetworkPolicy } from "./url-guard.js";

/**
 * T3.7: one verifier, one browser, the whole checklist.
 *
 * For every contract item, in order: run the check with a time limit, scan
 * every page it loaded with the tripwire, store the screenshot and details
 * under their SHA-256, and record a leaf. Then hash the leaves into a Merkle
 * tree and sign the root. Touches no database; the orchestrator stores results.
 */

export interface ItemProgress {
  verifierId: string;
  m: number;
  i: number;
  leaf: LeafRecord;
}

export interface RunVerifierArgs {
  verifierId: string;
  key: VerifierKey;
  provider: BrowserProvider;
  /** Why this slot is not using its planned browser, if it is not. Goes into the signed attestation. */
  fallback?: string;
  judgeModel: string;
  jobId: string;
  contract: Checklist;
  contractHash: string;
  deliverableUrl: string;
  network: NetworkPolicy;
  checkTimeoutMs: number;
  store: EvidenceStore;
  onItem?: (p: ItemProgress) => void;
  now?: () => Date;
}

export interface VerifierRunResult {
  report: VerifierReport;
  browserLabel: string;
  replayUrl?: string;
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

async function withTimeout(p: Promise<CheckResult>, ms: number): Promise<CheckResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<CheckResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ verdict: "fail", measured_value: null, summary: `Check did not finish within ${Math.round(ms / 1000)} s` }),
      ms,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runVerifier(args: RunVerifierArgs): Promise<VerifierRunResult> {
  const session = await args.provider.open({ network: args.network, replay: args.provider.kind === "kernel-chromium" });
  try {
    const browserLabel = clip(session.label + (args.fallback ? ` (fallback: ${args.fallback})` : ""), 100);
    const leaves: LeafRecord[] = [];

    for (const { m, i, item } of contractItems(args.contract)) {
      const scans: TripwireReport[] = [];
      const scanErrors: string[] = [];
      const blockedBefore = session.blocked.length;
      const result = await withTimeout(
        runCheck(item, {
          session,
          deliverableUrl: args.deliverableUrl,
          timeoutMs: args.checkTimeoutMs,
          onPageLoaded: async (page, url) => {
            try {
              scans.push(await scanPage(page));
            } catch (err) {
              scanErrors.push(`${url}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
            }
          },
        }),
        args.checkTimeoutMs + 5_000,
      );

      const findings = scans.flatMap((s) => s.findings);
      const injection = findings.length > 0;
      const artifacts: Record<string, string> = {};
      if (result.screenshot) artifacts.screenshot_sha256 = args.store.put(result.screenshot, "png").sha256;
      const details = {
        check: result.details ?? null,
        tripwire: { findings, warnings: scans.flatMap((s) => s.warnings), pages: scans.map((s) => ({ url: s.url, scanned: s.scanned })) },
        blocked_requests: session.blocked.slice(blockedBefore),
        tripwire_errors: scanErrors,
      };
      artifacts.details_sha256 = args.store.put(canonicalJson(details), "json").sha256;

      const first = findings[0];
      // If a page could not be scanned, this verifier cannot vouch for it: no vote (error), reason recorded.
      const unscanned = !injection && scanErrors.length > 0;
      const summary = injection
        ? `Prompt-injection attempt (${first!.techniques.join(" + ")}): "${clip(first!.text, 140)}". ${result.summary}`
        : unscanned
          ? `Tripwire scan failed (${clip(scanErrors[0]!, 200)}), so this verifier abstains. Check said: ${result.summary}`
          : result.summary;
      const leaf: LeafRecord = {
        m,
        i,
        check_type: item.check_type,
        // An injection attempt is a fail vote, whatever the check itself found (section 6.9).
        verdict: injection ? "fail" : unscanned ? "error" : result.verdict,
        injection,
        measured_value: result.measured_value === null ? null : clip(result.measured_value, 2000),
        summary: clip(summary, 2000),
        artifacts,
      };
      leaves.push(leaf);
      args.onItem?.({ verifierId: args.verifierId, m, i, leaf });
    }

    const replayUrl = await session.stopReplay().catch(() => undefined);
    const attestation = signAttestation(
      {
        v: PROTOCOL,
        type: "attestation",
        job_id: args.jobId,
        contract_hash: args.contractHash,
        deliverable_url: args.deliverableUrl,
        verifier_id: args.verifierId,
        browser: browserLabel,
        judge_model: args.judgeModel,
        merkle_root: evidenceRoot(leaves),
        leaf_count: leaves.length,
        issued_at: (args.now?.() ?? new Date()).toISOString(),
      },
      args.key,
    );
    return { report: { attestation, leaves }, browserLabel, replayUrl };
  } finally {
    await session.close().catch(() => undefined);
  }
}
