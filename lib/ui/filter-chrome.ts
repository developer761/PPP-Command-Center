/**
 * Shared styling for the Sender / Status / Date filter rows (R4.4).
 *
 * Kate asked for the Materials Ordering list to get "the same filter set" as
 * Mail Hub. Same set means same look — two hand-copied class strings drift the
 * first time either row is touched, and then only one of them has the 44px
 * mobile tap target or the focus ring.
 *
 * ── Mobile (Karan 2026-08-31) ────────────────────────────────────────────
 * These groups hold up to THREE selects ("Colors submitted", "Custom range…",
 * "Don't sort by this") plus a label, and every select is text-base on phones
 * so iOS Safari doesn't zoom the page on focus. Three 16px selects do not fit
 * across 430px. Previously the groups were `inline-flex` with no width rule:
 * the Date group wrapped into a ragged block with its label stranded, and the
 * Status group — which had no flex-wrap at all — overflowed instead of
 * wrapping. Nothing in either page provides an overflow-x container to catch
 * that, so it pushed the layout.
 *
 * Fix: below `sm`, each group is a full-width block and its controls share the
 * row (`flex-1 min-w-0`), so a group reads as one tidy band that stacks under
 * the previous one. At `sm` and up the groups revert to `inline-flex` with
 * intrinsically-sized controls — desktop is byte-for-byte what it was.
 */

/** A select/date input inside a filter group. 44px on mobile per iOS HIG;
 *  text-base so iOS Safari doesn't zoom the page on focus.
 *
 *  `flex-1 min-w-0` on mobile lets several selects share one row and shrink
 *  rather than push past the viewport — `min-w-0` is the load-bearing half,
 *  since a flex item defaults to min-width:auto and refuses to shrink below
 *  its longest option. `sm:flex-none` restores intrinsic width on desktop. */
export const FILTER_SEL =
  "flex-1 min-w-0 sm:flex-none rounded-lg border border-ppp-charcoal-200 px-2 py-1.5 text-base sm:text-[12px] text-ppp-charcoal focus:outline-none focus:ring-2 focus:ring-ppp-blue-400 min-h-[44px] sm:min-h-[36px]";

/** The tinted group wrappers. Colour separates the three groups so the row
 *  reads as three decisions rather than one run of six dropdowns.
 *
 *  Full-width flex on phones, inline-flex from `sm` up — see the note above. */
const FILTER_GROUP_BASE =
  "flex w-full flex-wrap items-center gap-1.5 min-w-0 sm:inline-flex sm:w-auto rounded-lg pl-2.5 pr-1.5 py-1 text-ppp-charcoal-600";

export const FILTER_GROUP_SENDER =
  `${FILTER_GROUP_BASE} bg-ppp-blue-50 border border-ppp-blue-100`;
export const FILTER_GROUP_STATUS =
  `${FILTER_GROUP_BASE} bg-ppp-green-50 border border-ppp-green-100`;
export const FILTER_GROUP_DATE =
  `${FILTER_GROUP_BASE} bg-ppp-orange-50/60 border border-ppp-orange-100`;
