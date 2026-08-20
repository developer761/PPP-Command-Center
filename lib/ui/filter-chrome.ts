/**
 * Shared styling for the Sender / Status / Date filter rows (R4.4).
 *
 * Kate asked for the Materials Ordering list to get "the same filter set" as
 * Mail Hub. Same set means same look — two hand-copied class strings drift the
 * first time either row is touched, and then only one of them has the 44px
 * mobile tap target or the focus ring.
 */

/** A select/date input inside a filter group. 44px on mobile per iOS HIG;
 *  text-base so iOS Safari doesn't zoom the page on focus. */
export const FILTER_SEL =
  "rounded-lg border border-ppp-charcoal-200 px-2 py-1.5 text-base sm:text-[12px] text-ppp-charcoal focus:outline-none focus:ring-2 focus:ring-ppp-blue-400 min-h-[44px] sm:min-h-[36px]";

/** The tinted group wrappers. Colour separates the three groups so the row
 *  reads as three decisions rather than one run of six dropdowns. */
export const FILTER_GROUP_SENDER =
  "inline-flex items-center gap-1.5 rounded-lg bg-ppp-blue-50 border border-ppp-blue-100 pl-2.5 pr-1.5 py-1 text-ppp-charcoal-600";
export const FILTER_GROUP_STATUS =
  "inline-flex items-center gap-1.5 rounded-lg bg-ppp-green-50 border border-ppp-green-100 pl-2.5 pr-1.5 py-1 text-ppp-charcoal-600";
export const FILTER_GROUP_DATE =
  "inline-flex items-center gap-1.5 flex-wrap rounded-lg bg-ppp-orange-50/60 border border-ppp-orange-100 pl-2.5 pr-1.5 py-1 text-ppp-charcoal-600";
