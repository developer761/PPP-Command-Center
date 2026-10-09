/**
 * Does a field's own label tell the truth about that field?
 *
 *   node scripts/check-field-copy-is-true.mjs
 *
 * WHY
 *
 * Stephanie 2026-10-09, the day after multi-CC shipped: "can I just add
 * multiple email addresses on the email line separated by a semicolon?" She
 * could. The parser took semicolons; the hint beside it named only commas and
 * spaces. Nothing was broken — the code and the sentence next to it simply
 * disagreed, and no test sees that, because each half is right on its own.
 *
 * WHAT THIS CHECKS, and deliberately nothing more
 *
 *   REQUIRED      A field labelled "(optional)" that is `required`, or marked
 *                 with a * that is not. Both send somebody into a form that
 *                 refuses them for a reason the screen denied.
 *
 *   LENGTH        Copy naming a limit — "up to 500 characters", "max 120" —
 *                 against the maxLength actually on the input.
 *
 * Both are LOCAL: the claim and the thing it describes are the same element in
 * the same file, so this can be read without guessing.
 *
 * WHAT IT CANNOT DO, said plainly rather than discovered later: separators.
 * The first version of this checked whether a field promising "comma or
 * semicolon" went through a split that takes them, and it could not work —
 * the copy lives in a component and the parser lives in lib/, so every one of
 * its six findings was a false positive (one of them because "Command Center"
 * contains the letters "comma"). Six permanent false positives is how a list
 * becomes one nobody reads. The two known separator cases are covered by
 * __tests__/commercial/proposal-cc-and-attention.test.ts instead.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const ROOTS = ["app", "components"];

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const n of entries) {
    const f = join(dir, n);
    const st = statSync(f);
    if (st.isDirectory()) walk(f, out);
    else if (/\.tsx$/.test(n) && !/\.test\.tsx$/.test(n)) out.push(f);
  }
  return out;
}

/** Comments are not shipped copy. A docblock explaining the rule must not
 *  satisfy a check looking for the rule — this repo has shipped that bug. */
const strip = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Each <input>/<textarea>/<select> tag, whole, so a claim is read against
 *  the element it is actually on. */
function elements(src) {
  return [...src.matchAll(/<(input|textarea|select)\b[^>]*>/g)].map((m) => ({
    tag: m[1],
    text: m[0],
    index: m.index,
  }));
}

const files = ROOTS.flatMap((r) => walk(join(ROOT, r)));
const required = [];
const lengths = [];
let elementsChecked = 0;

for (const f of files) {
  const src = strip(readFileSync(f, "utf8"));
  const rel = relative(ROOT, f);

  for (const el of elements(src)) {
    elementsChecked++;
    const isRequired = /\brequired\b(?!=\{false\})/.test(el.text);
    // The label sits just before the control in every form in this codebase.
    const before = src.slice(Math.max(0, el.index - 320), el.index);
    const label = before.split(/<label\b/).pop() ?? before;
    const saysOptional = /\(optional\)|\boptional\b/i.test(label);
    /*
     * ONLY A TRAILING ASTERISK, and only at the very end of the label.
     *
     * The first version also matched the word "Required", which is a field
     * NAME here, not a marker: "Required by" is the date a work order is
     * needed. It flagged that date and a supplier email whose 320-character
     * window happened to contain a stray `*`. Two findings, both false, which
     * is how a list stops being read.
     *
     * The asterisk convention in this codebase is `Label *` immediately before
     * the control, so that is what this looks for and nothing else.
     */
    const saysRequired = /\*\s*(?:<\/span>|<\/[a-z]+>)?\s*$/.test(label.trimEnd());

    if (isRequired && saysOptional && !saysRequired) {
      required.push({ rel, el: el.text.slice(0, 110), why: 'labelled optional but `required`' });
    }
    /*
     * THE OTHER DIRECTION IS NOT CHECKED, and that is a decision.
     *
     * "Marked * but no `required` attribute" sounds like the same bug and is
     * not. This codebase guards those fields with a disabled submit —
     * `valid = name.trim().length > 0`, `disabled={!valid}` — which is
     * STRONGER than the attribute: it refuses before the click instead of
     * after it, and says why. Flagging it asked a correct pattern to justify
     * itself. Both findings that direction produced were of exactly that kind.
     *
     * What remains is the direction that cannot be anything but a defect: a
     * field the screen calls optional that then refuses to let you past.
     */
    void saysRequired;

    // "up to 500 characters" / "max 120 characters" against maxLength.
    const claim = /(?:up to|max(?:imum)?(?: of)?)\s+([\d,]{2,6})\s*characters/i.exec(before);
    const cap = /maxLength=\{?(\d+)\}?/.exec(el.text);
    if (claim && cap) {
      const said = Number(claim[1].replace(/,/g, ""));
      const real = Number(cap[1]);
      if (said !== real) {
        lengths.push({ rel, said, real, el: el.text.slice(0, 110) });
      }
    }
  }
}

console.log("\nA field's label against the field itself\n");
console.log(`  scanned ${files.length} files · ${elementsChecked} form controls`);
if (files.length === 0 || elementsChecked === 0) {
  console.log("\n  Scanned nothing. Refusing to report a clean bill over an empty set.\n");
  process.exit(1);
}

const show = (title, rows, fmt) => {
  console.log(`\n  ${title}: ${rows.length}`);
  for (const r of rows.slice(0, 25)) console.log("    " + fmt(r));
};
show("LABELLED ONE WAY, BEHAVES THE OTHER", required, (r) => `${r.rel}\n      ${r.why}\n      ${r.el}`);
show("CHARACTER LIMIT THE COPY GETS WRONG", lengths, (r) => `${r.rel}\n      says ${r.said}, enforces ${r.real}\n      ${r.el}`);

const total = required.length + lengths.length;
console.log(
  total === 0
    ? "\n  Every label matches the control it describes.\n"
    : "\n  Findings are QUESTIONS — open each before believing it.\n",
);
process.exit(total === 0 ? 0 : 1);
