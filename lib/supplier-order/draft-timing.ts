/**
 * How long to wait before asking the server to rebuild the draft.
 *
 * Two different jobs, which is why this is a function and not a constant:
 *
 *  · Stepping a quantity fires a change per press. At 150ms each press queued
 *    its own Salesforce-backed rebuild, so holding "+" produced a burst of
 *    requests and the number visibly chased the button. Coalesce those.
 *
 *  · The FIRST draft for a vendor has nothing to coalesce — there are no
 *    earlier presses. Charging it the same delay meant opening the builder sat
 *    on an empty panel before the request even left the browser, on top of the
 *    round trip. Karan 2026-09-09: "to pop up the build your order when getting
 *    onto this page… takes like 5 seconds."
 *
 * Lives here rather than inline so it can be tested by BEHAVIOUR. The test that
 * used to guard this read the component's source for `}, DRAFT_DEBOUNCE_MS);`
 * and broke on this very change while the behaviour it cared about was intact —
 * a source-text assertion passes through real regressions and fails on
 * harmless edits.
 */
export const DRAFT_DEBOUNCE_MS = 600;

export function draftDelayMs(isFirstDraftForSupplier: boolean): number {
  return isFirstDraftForSupplier ? 0 : DRAFT_DEBOUNCE_MS;
}
