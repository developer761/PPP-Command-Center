#!/usr/bin/env node
/**
 * One form field name, rendered once.
 *
 * WHAT WENT WRONG. The payroll cost panel rendered a phone card list AND a
 * desktop table, one hidden with `sm:hidden` / `hidden sm:block`. Both are in
 * the DOM and both POST, so every employee had two inputs named
 * `cost_<id>` in one form. The save loop keeps the last value it reads, so on
 * a phone Mary typed a Gusto figure into the card she could see and the hidden
 * desktop input's stale value overwrote it — the cost silently reverted to
 * what it had been. Pasting a column failed the mirror way on desktop, filling
 * the hidden card and appearing to do nothing at all.
 *
 * Nothing caught it. Types cannot see it, the unit suite has no DOM, and the
 * smoke test loads the page without submitting it. It is a money bug that is
 * invisible on whichever layout you happen to be testing on.
 *
 * WHAT THIS CHECKS, AND WHY IT IS THIS NARROW. The first version flagged every
 * field name written twice in a file. All ten hits were fine — separate forms
 * in one file, and `cond ? <input/> : <input/>` branches where only one ever
 * renders. A check that is wrong ten times out of ten gets muted, so it is
 * scoped to the shape that actually broke: a file that renders TWO responsive
 * layouts of the same thing (`sm:hidden` beside `hidden sm:block`) and repeats
 * a field name across them. There, both copies really are in the DOM at once,
 * and one of them is always invisible to whoever is testing.
 *
 * It is deliberately a source check rather than a behavioural one, because the
 * defect IS a source fact — an attribute written twice — and the unit suite
 * has no DOM to observe it in.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Walk the tree rather than `git ls-files`: a component written this session
 *  is not tracked yet, and that is exactly when it needs checking. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const files = [...walk("components"), ...walk("app")];

/**
 * Known-good duplicates, each with the reason it is one. A bare allowlist
 * rots into "things somebody silenced"; a reason can be argued with.
 */
const ACCEPTED = new Map([
  // file -> [[name expression, why]]
]);

const problems = [];

/** A file that paints the same UI twice, once per breakpoint. */
const HIDE_AT = /\b(sm|md|lg|xl):hidden\b/;
const SHOW_AT = /\bhidden\s+(sm|md|lg|xl):(block|flex|grid|table|inline|inline-flex)\b/;

let dualLayoutFiles = 0;

for (const file of files) {
  const src = readFileSync(file, "utf8");

  // Only files carrying BOTH halves of a breakpoint swap can hold the bug.
  if (!HIDE_AT.test(src) || !SHOW_AT.test(src)) continue;
  dualLayoutFiles += 1;


  // PER FORM, not per file. Counting per file said "2 forms, could be one
  // field in each, skip" — and skipped the real bug, because the panel happens
  // to hold a second <form> for the Post button. A `start` hidden input in
  // each of two forms is correct; two `cost_<id>` inputs inside ONE form is
  // the defect. Splitting on the tag distinguishes them.
  // Each segment must STOP at its closing tag. Splitting on the opening tag
  // alone let a form's segment run on through everything after `</form>` until
  // the next form began, so fields that merely sat between two forms were
  // reported as duplicates inside the first one.
  const segments = src
    .split(/<form\b/)
    .slice(1)
    .map((s) => s.split("</form>")[0]);
  if (segments.length === 0) continue; // nothing here is a form field

  for (const [i, seg] of segments.entries()) {
    const counts = new Map();
    for (const m of seg.matchAll(/\sname=(\{`[^`]+`\}|"[^"]*")/g)) {
      // The attributes of one JSX element are everything between its own `<`
      // and the next `<`, since no child tag can appear among them. That block
      // is what decides whether this occurrence counts.
      const open = seg.lastIndexOf("<", m.index);
      const nextTag = seg.indexOf("<", m.index);
      const attrs = seg.slice(open, nextTag === -1 ? seg.length : nextTag);

      // `form="other-form"` moves a control into a DIFFERENT form no matter
      // where it sits in the DOM — real HTML, and the accounts filter popover
      // uses it to keep filters out of the search form. Text alone cannot see
      // that nesting is not ownership.
      if (/\sform=["']/.test(attrs)) continue;

      // Radios and checkboxes share a name BY DESIGN — one is a group, the
      // other a multi-value list read with getAll.
      if (/type=["'](radio|checkbox)["']/.test(attrs)) continue;

      // Hidden inputs are machine-written, never typed into, and repeat
      // legitimately across `cond ? <input value="a"/> : <input value="b"/>`
      // branches. The bug this guards is a field a PERSON fills existing
      // twice, where the copy they cannot see overwrites the one they used.
      if (/type=["']hidden["']/.test(attrs)) continue;

      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
    for (const [expr, n] of counts) {
      if (n < 2) continue;
      const why = (ACCEPTED.get(file) ?? []).find(([e]) => e === expr);
      if (why) continue;
      problems.push({ file, expr, n, form: i + 1 });
    }
  }
}

if (problems.length === 0) {
  console.log(
    `✅ ${dualLayoutFiles} of ${files.length} components render two responsive layouts — ` +
      `none repeats a form field name across them.`,
  );
  process.exit(0);
}

console.log(`❌ ${problems.length} duplicated form field name(s):\n`);
for (const p of problems) {
  console.log(`   ${p.file}`);
  console.log(`      name=${p.expr} appears ${p.n}× inside form #${p.form}`);
  console.log(
    `      Two inputs with one name POST twice; the reader keeps one of them, and whichever`,
  );
  console.log(
    `      layout is hidden wins at random. Render the field once and flex the layout instead.\n`,
  );
}
process.exit(1);
