#!/usr/bin/env node
/**
 * Audit: popovers clipped by an ancestor that hides overflow.
 *
 * Stephanie 2026-08-13: *"Exclusion drop down cuts off and I am unable to
 * scroll lower to see all of my options."* The picker's own list scrolled
 * fine — the CARD around it had `overflow-hidden`, so everything past the card
 * border was unreachable rather than merely hidden. That is a silent failure:
 * the dropdown looks fine until its list is long enough to reach the edge, and
 * neither TypeScript nor the tests can see it.
 *
 * The FIRST version of this script reported "no clipped popovers" on a
 * codebase that had one — it tracked nesting by the indentation of whichever
 * line held `className`, but this codebase writes multi-line JSX where the
 * className sits BELOW the tag it belongs to. Every card therefore looked like
 * it closed immediately and no ancestor was ever open. So this version is
 * tag-aware: it accumulates a tag's whole opening span, and nests by the
 * indentation of the `<Tag` line itself.
 *
 * Verified by reintroducing the original bug and confirming it is reported.
 *
 * Run: node scripts/audit-clipped-popovers.cjs
 */

const { readFileSync, readdirSync, statSync } = require("node:fs");
const { join, relative, basename } = require("node:path");

const ROOT = join(__dirname, "..");
const DIRS = ["app", "components"];

/** Tailwind that makes an element clip its children. */
const CLIPS = /\boverflow-hidden\b|\boverflow-clip\b/;
/**
 * An escaping panel: out of flow, on its own layer, offset from its trigger.
 *
 * All three signals are needed. `absolute` alone matches every chevron icon
 * sitting inside an input; requiring only `top-full` missed the many panels
 * written as `absolute z-50 mt-1 left-0 right-0` (new-deal-account-picker,
 * saved-view-picker, next-step-button). A z-index plus a vertical offset is
 * what actually distinguishes a dropdown from decoration.
 */
const PANEL = /\babsolute\b/;
const LAYERED = /\bz-\d+/;
const ANCHORED = /\bmt-[\d.]+|\btop-full\b|\bbottom-full\b/;
const isPanel = (text) => PANEL.test(text) && LAYERED.test(text) && ANCHORED.test(text);
/** Fixed-height clipped bars (progress meters, avatars) hold no popover. */
const NOT_A_CARD = /\bh-\d|\brounded-full\b|\baspect-/;

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx|jsx)$/.test(e)) files.push(p);
  }
})(join(ROOT, DIRS[0]));
for (const d of DIRS.slice(1)) {
  (function walk(dir) {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e.startsWith(".")) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx|jsx)$/.test(e)) files.push(p);
    }
  })(join(ROOT, d));
}

/**
 * Split a file into JSX opening tags, each with its FULL attribute span and
 * the indentation of its `<Tag` line. Returns tags in source order.
 */
function readTags(src) {
  const lines = src.split("\n");
  const tags = [];
  for (let i = 0; i < lines.length; i++) {
    // Closing tags are dedent events. Without them, a card that closes and is
    // followed by a MORE-indented sibling keeps looking like an open ancestor
    // — which reported three false clipped selects in the calendar toolbar.
    const close = lines[i].match(/^(\s*)<\//);
    if (close) {
      tags.push({ name: "/", indent: close[1].length, line: i + 1, text: "", closing: true });
      continue;
    }
    const m = lines[i].match(/^(\s*)<([A-Za-z][\w.]*)/);
    if (!m) continue;
    const indent = m[1].length;
    let text = lines[i];
    let j = i;
    // Accumulate until the opening tag closes. Bounded so a stray `<` can't
    // swallow the file.
    while (!/\/?>\s*$/.test(text.trim()) && j - i < 40 && j + 1 < lines.length) {
      j++;
      text += " " + lines[j].trim();
    }
    tags.push({ name: m[2], indent, line: i + 1, text, selfClosing: /\/>\s*$/.test(text.trim()) });
  }
  return tags;
}

// ── Pass 1: which components render an escaping, anchored panel? ──
// Named by BOTH their exported symbols and their filename, because a picker
// exported as a default or a const would otherwise be invisible — which is
// how ExclusionPicker slipped past the first version of this script.
const POPOVER_COMPONENTS = new Set();
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const hasPanel = readTags(src).some((t) => !t.closing && isPanel(t.text));
  if (!hasPanel) continue;
  for (const m of src.matchAll(/export\s+(?:default\s+)?function\s+([A-Z]\w+)/g)) POPOVER_COMPONENTS.add(m[1]);
  for (const m of src.matchAll(/export\s+const\s+([A-Z]\w+)/g)) POPOVER_COMPONENTS.add(m[1]);
  POPOVER_COMPONENTS.add(
    basename(f).replace(/\.(tsx|jsx)$/, "").split("-").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("")
  );
}

// ── Pass 1b: which COMPONENTS clip whatever you put inside them? ──
// This is the pass that actually catches Stephanie's bug, and the reason the
// first two versions of this script reported a clean codebase that wasn't.
// `EditorSection` carries the `overflow-hidden` in its OWN definition, so at
// the call site `<EditorSection><ExclusionPicker/></EditorSection>` there is
// nothing to see. The clipping is one level of indirection away.
//
// So: find each component's ROOT element and ask whether it clips. A card that
// clips its own root clips every child anyone ever passes it.
const CLIPPING_COMPONENTS = new Set();
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const lines = src.split("\n");
  const tags = readTags(src);
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const fn = lines[i].match(/(?:export\s+)?(?:default\s+)?function\s+([A-Z]\w+)/) ||
      lines[i].match(/const\s+([A-Z]\w+)\s*[:=][^=]*=>/);
    if (fn) current = fn[1];
    if (!current || !/^\s*return\s*\(\s*$/.test(lines[i])) continue;
    const root = tags.find((t) => t.line > i + 1 && !t.closing);
    if (root && CLIPS.test(root.text) && !NOT_A_CARD.test(root.text)) {
      CLIPPING_COMPONENTS.add(current);
    }
  }
}

// ── Pass 2: is any of them nested under a clipping ancestor? ──
/**
 * Accepted, with a reason — not silently ignored.
 *
 * A dropdown inside a SCROLLING drawer is a different fault from a dropdown
 * inside a short card. It is positioned against a field that scrolls with the
 * drawer body, so a list running past the drawer edge stays reachable: the
 * user scrolls and it comes into view. Stephanie's bug was the other kind —
 * a fixed-height card where the options past the border could never be
 * reached at all.
 *
 * The complete fix is rendering the panel through a portal, which is a change
 * to SearchableSelect affecting every surface that uses it. Worth doing on its
 * own, not as a footnote to a proposal-editor pass.
 */
const ACCEPTED = [
  { file: "app/commercial/accounts/[id]/page.tsx", ancestor: 6149, why: "slide-out drawer: panel scrolls with its field, so nothing is unreachable" },
];

const findings = [];
for (const f of files) {
  const tags = readTags(readFileSync(f, "utf8"));
  const clipping = []; // open clipping ancestors: { indent, line }

  for (const t of tags) {
    if (t.closing) {
      // A close at indent N ends every open clipper at indent >= N.
      while (clipping.length > 0 && clipping[clipping.length - 1].indent >= t.indent) clipping.pop();
      continue;
    }
    while (clipping.length > 0 && t.indent <= clipping[clipping.length - 1].indent) clipping.pop();

    const isPopover =
      POPOVER_COMPONENTS.has(t.name) || isPanel(t.text);
    const ancestorLine = clipping.length > 0 ? clipping[clipping.length - 1].line : 0;
    const accepted = ACCEPTED.some(
      (a) => relative(ROOT, f) === a.file && a.ancestor === ancestorLine
    );
    if (isPopover && clipping.length > 0 && !accepted) {
      findings.push({
        file: relative(ROOT, f),
        line: t.line,
        culprit: `<${t.name}>`,
        clippedBy: clipping[clipping.length - 1].line,
      });
    }

    // Register AFTER the check, so a scrolling list that clips itself is not
    // reported as its own ancestor.
    const clipsOwnMarkup = CLIPS.test(t.text) && !NOT_A_CARD.test(t.text);
    if ((clipsOwnMarkup || CLIPPING_COMPONENTS.has(t.name)) && !t.selfClosing) {
      clipping.push({ indent: t.indent, line: t.line });
    }
  }
}

if (findings.length === 0) {
  console.log(`✓ no clipped popovers (${files.length} files, ${POPOVER_COMPONENTS.size} popover components known)`);
  process.exit(0);
}
console.log(`✗ ${findings.length} popover(s) inside an overflow-clipping ancestor:\n`);
for (const x of findings) {
  console.log(`  ${x.file}:${x.line}  ${x.culprit} — clipped by ancestor at line ${x.clippedBy}`);
}
console.log(`\nA clipped dropdown looks fine until its list reaches the card edge, then`);
console.log(`the options past it become unreachable. Drop the overflow-hidden and round`);
console.log(`the inner header instead (see EditorSection in the proposal editor).`);
process.exit(1);
