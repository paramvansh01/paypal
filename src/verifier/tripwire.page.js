/*
 * Runs INSIDE the verified page (via Playwright's page.evaluate), so it must be
 * plain, self-contained browser JavaScript. It is read as text and sent as-is:
 * never import it, and keep it out of any build step (a compiler may inject
 * helpers such as esbuild's __name that do not exist in the page).
 *
 * Returns every piece of text a model could read, with the ways it is hidden.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function collectInPage(maxItems) {
  const out = [];
  const clip = (s) => s.replace(/\s+/g, " ").trim().slice(0, 400);
  const pathOf = (el) => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 4; e = e.parentElement) {
      let p = e.tagName.toLowerCase();
      if (e.id) p += `#${e.id}`;
      else if (e.classList.length) p += `.${[...e.classList].slice(0, 2).join(".")}`;
      parts.unshift(p);
    }
    return parts.join(" > ");
  };
  const parseRgb = (c) => {
    const m = c.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/);
    if (!m) return null;
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), a];
  };
  const lum = ([r, g, b]) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const background = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const c = parseRgb(getComputedStyle(e).backgroundColor);
      if (c && c[3] > 0.5) return c;
    }
    return [255, 255, 255, 1];
  };
  const docW = Math.max(document.documentElement.scrollWidth, window.innerWidth);
  const docH = Math.max(document.documentElement.scrollHeight, window.innerHeight);

  const hiddenWays = (el) => {
    const ways = [];
    for (let e = el; e; e = e.parentElement) {
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
  const seen = new Set();
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
    out.push({ text, techniques: ways.length ? ways : ["visible"], where: pathOf(parent) });
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
