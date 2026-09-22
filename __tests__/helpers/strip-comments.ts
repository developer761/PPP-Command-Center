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
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "") // JSX comment braces
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments, docblocks included
    .replace(/^\s*\/\/.*$/gm, "") // whole-line comments
    .replace(/\/\/.*$/gm, ""); // trailing comments
}
