import { readFileSync } from "node:fs";
import type { Page } from "playwright";

/**
 * QAPS part 3a: the DOM tripwire scanner (section 6.10).
 *
 * Finds text a model would read but a person would not see (hidden by CSS,
 * same colour as the background, tiny, off-screen, clipped, in comments,
 * attributes or <meta>), and flags it when it reads like instructions aimed at
 * an AI evaluator. Hidden + instruction-like = injection attempt. Visible
 * instruction-like text is only a warning (it may be a legitimate page).
 *
 * Deterministic: no model is involved, so it cannot itself be talked out of a verdict.
 */

export type Technique =
  | "display:none"
  | "visibility:hidden"
  | "opacity:0"
  | "tiny-font"
  | "same-colour-as-background"
  | "off-screen"
  | "clipped-or-zero-size"
  | "html-comment"
  | "attribute"
  | "meta"
  | "noscript"
  | "template"
  | "visible";

/** One piece of text found in the page, as the browser reported it. */
export interface RawText {
  text: string;
  /** Empty when visible. A text can be hidden in several ways at once. */
  techniques: Technique[];
  /** Short CSS-like path to where it was found, for the evidence. */
  where: string;
}

export interface Finding extends RawText {
  hidden: boolean;
  /** Which rule families matched: override, addressing, directive. */
  matched: string[];
}

export interface TripwireReport {
  url: string;
  injection: boolean;
  /** Hidden + instruction-like. */
  findings: Finding[];
  /** Visible + instruction-like (recorded, not a failure). */
  warnings: Finding[];
  /** How many text fragments were examined. */
  scanned: number;
}

// ---------- classification (pure) ----------

const OVERRIDE = [
  /\bignore\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|other|failed|any)\b[^.\n]{0,30}\b(?:instructions?|prompts?|directions?|results?|checks?|rules|failures?)\b/i,
  /\bdisregard\b[^.\n]{0,40}\b(?:instructions?|rules|checklist|results?|failures?|checks?)\b/i,
  /\b(?:system|developer)\s+(?:prompt|note|message|override|instruction)s?\b/i,
  /\bverification\s+override\b/i,
  /\bverdict\s*[:=]/i,
  /<\/?\s*(?:system|assistant|instructions?)\s*>/i,
  /\[\/?(?:INST|SYS)\]/,
];
const ADDRESSING = [
  /\b(?:ai|llm|language[-\s]model|automated|bot)\b[^.\n]{0,20}\b(?:verifiers?|reviewers?|evaluators?|graders?|judges?|checkers?|agents?|assistants?|systems?)\b/i,
  /\b(?:you\s+are|you're|as)\s+an?\s+(?:ai|llm|language\s+model|evaluator|verifier|grader|reviewer|judge)\b/i,
  /\bnote\s+to\s+(?:the\s+)?(?:ai|bots?|automated|reviewers?|verifiers?|evaluators?|graders?|llms?)\b/i,
  /\b(?:ai|llm)\s*:/i,
];
const DIRECTIVE = [
  /\b(?:mark|set|report|treat|grade|score|rate|return|respond|answer|output|say|consider|record|approve)\b[^.\n]{0,60}\b(?:pass(?:ed|es)?|approved?|complete[d]?|success(?:ful)?|works?|working|correct(?:ly)?|true|yes|verified)\b/i,
  /\b(?:ignore|disregard|must|should|always|never|do\s+not|don't)\b/i,
];

export function classify(text: string): { instructionLike: boolean; matched: string[] } {
  const matched: string[] = [];
  if (OVERRIDE.some((r) => r.test(text))) matched.push("override");
  if (ADDRESSING.some((r) => r.test(text))) matched.push("addressing");
  if (DIRECTIVE.some((r) => r.test(text))) matched.push("directive");
  const instructionLike = matched.includes("override") || (matched.includes("addressing") && matched.includes("directive"));
  return { instructionLike, matched };
}

export function analyse(url: string, raw: readonly RawText[]): TripwireReport {
  const findings: Finding[] = [];
  const warnings: Finding[] = [];
  for (const r of raw) {
    const { instructionLike, matched } = classify(r.text);
    if (!instructionLike) continue;
    const hidden = r.techniques.length > 0 && !r.techniques.includes("visible");
    (hidden ? findings : warnings).push({ ...r, hidden, matched });
  }
  return { url, injection: findings.length > 0, findings, warnings, scanned: raw.length };
}

// ---------- collection (runs inside the page) ----------

/**
 * The in-page collector lives in tripwire.page.js and is sent to the browser as
 * text, so no TypeScript/esbuild transform can inject helpers into it.
 */
const COLLECTOR_SOURCE = readFileSync(new URL("./tripwire.page.js", import.meta.url), "utf8");

export async function collectText(page: Page, maxItems = 3000): Promise<RawText[]> {
  const n = Math.max(1, Math.min(10_000, Math.floor(maxItems)));
  return page.evaluate(`(${COLLECTOR_SOURCE})(${n})`) as Promise<RawText[]>;
}

/** Scans the page as it is right now. */
export async function scanPage(page: Page): Promise<TripwireReport> {
  return analyse(page.url(), await collectText(page));
}
