/**
 * Strip comments from source before asserting anything about it.
 *
 * Five separate tests in this suite have now failed — or worse, PASSED —
 * because they matched a COMMENT rather than code: a Slack ordering test, a
 * `reply_to_email` test, a `precisionpaintingplus` ban, hub.ts, and the
 * draft-only-guard test, which went red the moment a docblock explaining WHY
 * the function is exempt from `assertProposalDraft` mentioned the guard by
 * name. A test that reads source text cannot tell prose from behaviour unless
 * the prose is removed first.
 *
 * Use this on every `readFileSync` a test then greps. It is deliberately the
 * only copy — both spellings of the same regex drifting apart is the next
 * version of this bug.
 */
export function stripComments(src: string): string {
  return src
    .replace(JSX_COMMENT, "") // JSX comment braces
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments, docblocks included
    .replace(/^\s*\/\/.*$/gm, "") // whole-line comments
    .replace(/\/\/.*$/gm, ""); // trailing comments
}

/**
 * `{/* … *␀/}` and NOTHING else — the comment body may not contain `*␀/`.
 *
 * This was `/\{\s*\/\*[\s\S]*?\*\/\s*\}/`, which looks equivalent and is
 * not. Lazy only means "stop at the first match that completes the
 * pattern", and the pattern does not complete until a `*␀/` is followed by
 * `}`. So an ordinary opening brace with a docblock under it —
 *
 *     type Props = {
 *       /** the first field *␀/
 *       bundle: LiveDashboardBundle;
 *
 * — matched from that `{` all the way to the next `{/* … *␀/}` ANYWHERE
 * later in the file, deleting every line in between.
 *
 * Found on 2026-10-16 by mutation-testing a new check: the bug was put
 * back into components/dashboard-view.tsx, and the test still passed.
 * stripComments was removing 18,608 of that file's 53,770 characters —
 * 35% — including `export default function DashboardView`. Seventeen test
 * files use this helper, so each had been asserting against source with a
 * third of the code silently missing, and any `not.toContain` among them
 * could have been passing on text it never saw.
 *
 * The lesson is the one already in this file's docblock, one level up: a
 * helper that quietly removes too much turns every test built on it into a
 * check that cannot fail.
 */
const JSX_COMMENT = /\{\s*\/\*(?:[^*]|\*(?!\/))*\*\/\s*\}/g;
