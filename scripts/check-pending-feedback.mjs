/**
 * Which submit controls still say NOTHING while the server works?
 *
 * Karan has now reported this three times, in the same words each time:
 *   2026-07-10  "the delete button takes like 5 seconds and isn't interactive
 *               whatsoever"                       → PendingSubmitButton was built
 *   2026-08-13  "there's like a delay and the UX isn't good"
 *                                                 → SubmitButton was built, and
 *                                                    its docstring says a sweep
 *                                                    found 101 forms like this
 *   2026-09-17  "the buttons take like 5 seconds to load and it's annoying"
 *
 * Two components already solve it. What was never finished is the SWEEP, and
 * the reason it keeps not finishing is that "does this button have feedback?"
 * is not greppable: the control often lives in a different file from its
 * <form>, and the feedback may come from useFormStatus, useTransition, or a
 * local `saving` flag. Grepping a file for "PendingSubmitButton" answers a
 * different question and answers it wrongly in both directions — my first pass
 * today called 22 files broken, and the first one I opened was fine.
 *
 * So this checks the CONTROL, not the file. It finds every raw <button> that
 * submits — `type="submit"`, or no `type` at all inside a <form>, which the
 * HTML spec makes a submit button — and reports the ones with no visible
 * pending state of their own.
 *
 *   node scripts/check-pending-feedback.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["app/commercial", "components/commercial"];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

/** Does this button element's own markup show that it is working? */
function hasOwnFeedback(tag) {
  return /aria-busy|disabled=\{[^}]*(pending|saving|busy|isPending)/i.test(tag);
}

const files = ROOTS.flatMap((r) => walk(r));
const findings = [];

/**
 * Strip comments before looking for markup.
 *
 * Without this the check reports its own documentation: four of the seven hits
 * on the first run were the words "<button>" inside comments explaining why a
 * plain button had already been REPLACED — including one in submit-button.tsx's
 * own docstring. A check that flags the note describing the fix is worse than
 * no check: the next person "fixes" a comment and the count never reaches zero.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // /* … */ and /** … */
    .replace(/^\s*\/\/.*$/gm, ""); // whole-line //
}

for (const file of files) {
  const src = stripComments(readFileSync(file, "utf8"));
  // A file with no server-action form has no submit round-trip to report on.
  const hasActionForm = /<form[^>]*\saction=\{/.test(src);
  if (!hasActionForm) continue;

  // Every raw <button …> opening tag, with its line number.
  const re = /<button\b[^>]*>/gs;
  let m;
  while ((m = re.exec(src))) {
    const tag = m[0];
    const line = src.slice(0, m.index).split("\n").length;
    const isExplicitSubmit = /type="submit"/.test(tag);
    const hasType = /type="/.test(tag);
    // No type inside a form = submit (HTML default). A button with an onClick
    // and type="button" is a client control, not a round-trip.
    const submits = isExplicitSubmit || !hasType;
    if (!submits) continue;
    if (hasOwnFeedback(tag)) continue;
    findings.push({ file, line, tag: tag.replace(/\s+/g, " ").slice(0, 90) });
  }
}

console.log(`\n${files.length} files scanned · ${findings.length} submit control(s) with no pending state\n`);
for (const f of findings) console.log(`  ${f.file}:${f.line}\n      ${f.tag}`);
if (findings.length === 0) console.log("  ✅ every raw submit button reports that it is working");
// Reported, not enforced: a raw <button> inside a form whose action is instant
// is not a defect, and failing the build on one would be noise.
console.log("");
