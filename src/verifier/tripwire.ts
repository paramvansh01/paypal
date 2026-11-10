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

/** Self-contained: serialised into the page by Playwright. Do not reference anything outside it. */
function collectInPage(maxItems: number): RawText[] {
  const out: RawText[] = [];
  const clip = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 400);
  const pathOf = (el: Element | null): string => {
    const parts: string[] = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 4; e = e.parentElement) {
      let p = e.tagName.toLowerCase();
      if (e.id) p += `#${e.id}`;
      else if (e.classList.length) p += `.${[...e.classList].slice(0, 2).join(".")}`;
      parts.unshift(p);
    }
    return parts.join(" > ");
  };
  const parseRgb = (c: string): [number, number, number, number] | null => {
    const m = c.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/);
    if (!m) return null;
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [parseFloat(m[1]!), parseFloat(m[2]!), parseFloat(m[3]!), a];
  };
  const lum = ([r, g, b]: number[]) => {
    const f = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
  };
  const background = (el: Element): number[] => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      const c = parseRgb(getComputedStyle(e).backgroundColor);
      if (c && c[3] > 0.5) return c;
    }
    return [255, 255, 255, 1];
  };
  const docW = Math.max(document.documentElement.scrollWidth, window.innerWidth);
  const docH = Math.max(document.documentElement.scrollHeight, window.innerHeight);

  const hiddenWays = (el: Element): string[] => {
    const ways: string[] = [];
    for (let e: Element | null = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.display === "none") ways.push("display:none");
      if (e === el && (s.visibility === "hidden" || s.visibility === "collapse")) ways.push("visibility:hidden");
      if (parseFloat(s.opacity) === 0) ways.push("opacity:0");
      if (e.tagName === "TEMPLATE") ways.push("template");
      if (e.tagName === "NOSCRIPT") ways.push("noscript");
      if ((s.clipPath && s.clipPath !== "none" && /inset\(\s*(?:50%|100%)|circle\(\s*0/.test(s.clipPath)) || /rect\(\s*0(?:px)?[,\s]+0(?:px)?[,\s]+0(?:px)?[,\s]+0/.test(s.clip)) {
        ways.push("clipped-or-zero-size");
      }
      if (e !== el && s.overflow === "hidden") {
        const r = e.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) ways.push("clipped-or-zero-size");
      }
    }
    const s = getComputedStyle(el);
    if (parseFloat(s.fontSize) < 4) ways.push("tiny-font");
    const r = el.getBoundingClientRect();
    if (!ways.includes("display:none") && (r.right < -50 || r.bottom < -50 || r.left > docW + 50 || r.top > docH + 50)) ways.push("off-screen");
    if (!ways.includes("display:none") && (r.width < 2 || r.height < 2) && s.overflow === "hidden") ways.push("clipped-or-zero-size");
    if (parseFloat(s.textIndent) < -999) ways.push("off-screen");
    const fg = parseRgb(s.color);
    if (fg) {
      if (fg[3] < 0.1) ways.push("same-colour-as-background");
      else {
        const L1 = lum(fg);
        const L2 = lum(background(el));
        const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
        if (ratio < 1.25) ways.push("same-colour-as-background");
      }
    }
    return [...new Set(ways)];
  };

  // Text nodes, grouped by their parent element.
  const seen = new Set<Element>();
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && out.length < maxItems; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (!parent || seen.has(parent)) continue;
    if (["SCRIPT", "STYLE"].includes(parent.tagName)) continue;
    seen.add(parent);
    const own = [...parent.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent ?? "").join(" ");
    const text = clip(own);
    if (text.length < 3) continue;
    const ways = parent.closest("head") && parent.tagName !== "TITLE" ? ["meta"] : hiddenWays(parent);
    out.push({ text, techniques: (ways.length ? ways : ["visible"]) as Technique[], where: pathOf(parent) });
  }
  // <template> contents are a separate document fragment.
  for (const t of document.querySelectorAll("template")) {
    const text = clip(t.content.textContent ?? "");
    if (text.length >= 3 && out.length < maxItems) out.push({ text, techniques: ["template"], where: pathOf(t) });
  }
  // Comments.
  const cw = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_COMMENT);
  for (let c = cw.nextNode(); c && out.length < maxItems; c = cw.nextNode()) {
    const text = clip(c.textContent ?? "");
    if (text.length >= 3) out.push({ text, techniques: ["html-comment"], where: pathOf(c.parentElement) });
  }
  // Attributes a model might read.
  const ATTRS = ["alt", "title", "aria-label", "aria-description", "placeholder", "content", "value"];
  for (const el of document.querySelectorAll("*")) {
    if (out.length >= maxItems) break;
    for (const a of el.getAttributeNames()) {
      if (!ATTRS.includes(a) && !a.startsWith("data-")) continue;
      const text = clip(el.getAttribute(a) ?? "");
      if (text.length < 8) continue;
      out.push({ text, techniques: [el.tagName === "META" ? "meta" : "attribute"], where: `${pathOf(el)}[${a}]` });
    }
  }
  return out;
}

export async function collectText(page: Page, maxItems = 3000): Promise<RawText[]> {
  return page.evaluate(collectInPage, maxItems);
}

/** Scans the page as it is right now. */
export async function scanPage(page: Page): Promise<TripwireReport> {
  return analyse(page.url(), await collectText(page));
}
