import type { Page } from "playwright";
import type { ChecklistItem } from "../../core/checklist.js";
import type { Vote } from "../../qaps/leaf.js";
import type { BrowserSession } from "../browser.js";
import type { Judge } from "../../llm/judge.js";

/** What one check reports for one checklist item. */
export interface CheckResult {
  /** pass / fail are about the deliverable; needs_client defers to a human; error means the verifier could not decide. */
  verdict: Vote;
  measured_value: string | null;
  summary: string;
  /** Raw PNG bytes of the page as the check left it, for evidence. */
  screenshot?: Buffer;
  /** Extra structured evidence (console errors, link statuses, …). Kept off the signed leaf; hashed as an artifact. */
  details?: Record<string, unknown>;
  /** The AI judge's integrity check failed (wrong canary, or it reported text aimed at evaluators): counts as an injection flag. */
  injectionSuspected?: boolean;
}

export interface CheckContext {
  session: BrowserSession;
  deliverableUrl: string;
  /** Budget for waits inside the check (the runner also enforces an outer timeout). */
  timeoutMs: number;
  /** Called after every page load, so the tripwire scanner sees every page a check visits. */
  onPageLoaded?: (page: Page, url: string) => Promise<void>;
  /** This verifier's AI judge for llm_judgement items (its own model). Without one, a person decides. */
  judge?: Judge;
}

export type Check<T extends ChecklistItem = ChecklistItem> = (item: T, ctx: CheckContext) => Promise<CheckResult>;
