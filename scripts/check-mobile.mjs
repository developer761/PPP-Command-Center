/**
 * Mobile hazards that compile clean and pass every test.
 *
 * Each rule maps to a concrete iPhone failure, not a style preference:
 *   ios-zoom     — a font-size under 16px on a focusable control makes iOS
 *                  Safari zoom the whole page on tap. There is no way back
 *                  except pinching. FILTER_SEL already carries text-base for
 *                  exactly this reason.
 *   tap-target   — Apple's HIG floor is 44x44. Below that, a gloved hand on a
 *                  job site misses.
 *   vh-unit      — 100vh / h-screen sits UNDER Safari's toolbar, so the last
 *                  ~80px of a full-height panel is unreachable. dvh is the fix.
 *   fixed-bottom — anything pinned to the bottom needs safe-area-inset-bottom
 *                  or the home indicator overlaps it.
 *   grid-fixed   — a multi-column grid with no responsive prefix keeps N
 *                  columns at 390px.
 *   wide-fixed   — a fixed width above 320px cannot fit the narrowest phone.
 *
 * Usage: node scripts/check-mobile.mjs [glob-ish path prefix ...]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["components", "app/dashboard/materials"];

const files = [];
const walk = (p) => {
  if (!statSync(p).isDirectory()) { if (/\.tsx?$/.test(p)) files.push(p); return; }
  for (const e of readdirSync(p)) { if (e === "node_modules" || e.startsWith(".")) continue; walk(join(p, e)); }
};
for (const r of ROOTS) walk(r);

const FOCUSABLE = /<(input|select|textarea)\b/i;
const findings = [];
const add = (rule, file, line, detail, snippet) =>
  findings.push({ rule, file, line, detail, snippet: snippet.trim().slice(0, 110) });

for (const f of files) {
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((raw, i) => {
    const n = i + 1;
    // A JSX element's attributes span several lines — the safe-area padding
    // sits on the line AFTER the className that pins it to the bottom, and a
    // wide table's overflow-x wrapper sits a line or two ABOVE. Judging either
    // by its own line alone reported both as broken when both were correct.
    const below = lines.slice(i, i + 6).join(" ");
    const above = lines.slice(Math.max(0, i - 4), i + 1).join(" ");
    const cls = [...raw.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map(m => m[1] || m[2]).join(" ");

    // ios-zoom: focusable control whose mobile font-size is under 16px.
    if (FOCUSABLE.test(raw) || /FILTER_SEL/.test(raw)) {
      const small = cls.match(/(?:^|\s)text-(xs|sm|\[(\d+)px\])/);
      const hasBase = /(?:^|\s)text-base/.test(cls);
      if (small && !hasBase) {
        const px = small[2] ? Number(small[2]) : small[1] === "xs" ? 12 : 14;
        if (px < 16) add("ios-zoom", f, n, `${px}px on a focusable control → iOS zooms the page on tap`, raw);
      }
    }

    // tap-target: an interactive element with an explicit height under 44px
    // and no mobile-first min-h to lift it.
    const isBox = /type=["'](checkbox|radio)["']/.test(raw);
    if (/<(button|a|select|input)\b/i.test(raw) && !isBox) {
      const h = cls.match(/(?:^|\s)h-(\d+)(?:\s|$)/);
      const minH = /min-h-\[4[4-9]px\]|min-h-\[[5-9]\dpx\]|min-h-11|min-h-12/.test(cls);
      if (h && Number(h[1]) * 4 < 44 && !minH) {
        add("tap-target", f, n, `h-${h[1]} = ${Number(h[1]) * 4}px, under the 44px floor`, raw);
      }
    }

    // vh-unit: unreachable under Safari's toolbar.
    const fullVh = /\b(h-screen|max-h-screen)\b/.test(cls) || /\b(100vh|9[5-9]vh)\b/.test(raw);
    const pinned = /\b(fixed|absolute)\b/.test(cls);
    if (fullVh && pinned && !/dvh/.test(raw)) {
      add("vh-unit", f, n, "full-height pinned panel in vh — bottom lands under Safari's toolbar; use h-dvh-full", raw);
    }

    // fixed-bottom without safe-area padding.
    // Only a bar actually PINNED to the bottom needs the inset. `fixed inset-0`
    // is a full-screen modal backdrop — the home indicator over a dimmed
    // overlay is not a defect, and flagging those was noise. The sheet CONTENT
    // inside still needs its own padding, but that is a different element.
    // `top-0 bottom-0` is a full-height side sheet, not a bottom-pinned bar —
    // it needs a safe-area inset only if it has its own bottom action row,
    // which is a property of that inner element, not this one.
    const fullHeightSheet = /\btop-0\b/.test(cls) || /\binset-y-0\b/.test(cls);
    if (/\bfixed\b/.test(cls) && /\bbottom-0\b/.test(cls) && !/\binset-0\b/.test(cls) && !fullHeightSheet) {
      if (!/safe-area-inset-bottom|pb-\[env/.test(below)) add("fixed-bottom", f, n, "pinned to bottom with no safe-area inset — home indicator overlaps", raw);
    }

    // grid-fixed: multi-column with no responsive prefix anywhere in the class.
    const gc = cls.match(/(?:^|\s)grid-cols-([2-9]|1[0-2])(?:\s|$)/);
    // `hidden sm:grid` never renders on a phone, so its column count is
    // irrelevant there — flagging it was pure noise. And 2-3 columns of short
    // stat text is a deliberate, legible layout at 390px; only 4+ genuinely
    // crushes. Both were false positives in the first run.
    const hiddenOnMobile = /(?:^|\s)hidden(?:\s|$)/.test(cls) && /(sm|md|lg):(grid|flex|block)/.test(cls);
    if (gc && Number(gc[1]) >= 4 && Number(gc[1]) !== 7 && !hiddenOnMobile && !/(sm|md|lg|xl):grid-cols-/.test(cls)) {
      add("grid-fixed", f, n, `grid-cols-${gc[1]} with no responsive variant — stays ${gc[1]} columns at 390px`, raw);
    }

    // wide-fixed: a hard width wider than the narrowest phone.
    for (const m of cls.matchAll(/(?:^|\s)(?:min-)?w-\[(\d+)px\]/g)) {
      if (Number(m[1]) <= 320) continue;
      // A wide table inside a horizontally-scrolling wrapper is the CORRECT
      // mobile pattern, not a defect. Only flag one with nowhere to scroll.
      if (/overflow-x-auto|overflow-x-scroll|overflow-auto|overflow-scroll/.test(above)) continue;
      // max-w / calc caps already bound it to the viewport.
      if (/max-w-\[calc\(100vw|max-w-full|max-w-\[100vw/.test(cls)) continue;
      add("wide-fixed", f, n, `${m[1]}px fixed width with no scroll wrapper and no viewport cap`, raw);
    }
  });
}

const order = ["ios-zoom", "tap-target", "vh-unit", "fixed-bottom", "grid-fixed", "wide-fixed"];
findings.sort((a, b) => order.indexOf(a.rule) - order.indexOf(b.rule) || a.file.localeCompare(b.file) || a.line - b.line);
console.log(`Scanned ${files.length} files under: ${ROOTS.join(", ")}\n`);
if (!findings.length) console.log("No mobile hazards found.");
for (const r of order) {
  const g = findings.filter((x) => x.rule === r);
  if (!g.length) continue;
  console.log(`\n${r.toUpperCase()} (${g.length})`);
  for (const x of g) console.log(`  ${x.file}:${x.line}\n     ${x.detail}\n     ${x.snippet}`);
}
console.log(`\nTOTAL: ${findings.length}`);
