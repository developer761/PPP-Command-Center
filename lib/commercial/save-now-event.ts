/**
 * "Save this NOW, don't wait for the typing debounce."
 *
 * The proposal editor debounces saves by 2.5s, which is right for a textarea
 * and wrong for a picker. Every edit in the exclusions list is a DISCRETE,
 * finished action — click an exclusion, remove one, add a custom line — and
 * there is no half-typed state to protect. Waiting 2.5s after a click means
 * the row appears instantly but the save pill does not, and clicking through
 * several in a row keeps pushing the save further out.
 *
 * Stephanie 2026-09-11: "Exclusions autosave after 3 seconds and it makes it
 * glitchy."
 *
 * A component that knows its edit is complete dispatches this; the enclosing
 * autosave form flushes immediately instead of restarting its timer.
 *
 * The name lives here rather than as a string literal in both files for the
 * same reason AUTOSAVE_FLAG does — a list maintained in two places where the
 * second place is invisible to TypeScript is how that flag went missing from
 * two surfaces for a month.
 */
export const SAVE_NOW_EVENT = "commercial:save-now";
