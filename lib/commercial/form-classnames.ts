/**
 * Shared classNames for the Commercial CC form controls. One source of
 * truth so polishing the form look across the platform is a single
 * edit. Karan flagged the default `<select>` styling as gray and ugly
 * three times — this module is the response: every select on the
 * platform pulls SELECT_CLS so the visual contract stays consistent.
 *
 * The styled select uses `appearance-none` to drop the OS chrome and
 * paints its own chevron via inline SVG background. Rounded-xl border,
 * white background, subtle shadow, emerald focus ring — matches the
 * rest of the platform's "live and confident" form language.
 */

// Inline SVG chevron, URL-encoded so it works as a background-image.
const CHEVRON_SVG = encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b7280" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`
);

/** Custom-styled <select> classname. Apply to every select in the
 *  Commercial CC so the look stays consistent. */
export const SELECT_CLS =
  `w-full appearance-none cursor-pointer pl-3.5 pr-10 py-2.5 text-base sm:text-sm bg-white border border-ppp-charcoal-200 rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 hover:border-ppp-charcoal-300 min-h-[44px] transition-colors bg-no-repeat ` +
  // Background-image must live in style prop (Tailwind can't process
  // URL-encoded SVG inside arbitrary values reliably). See INPUT_BG_STYLE.
  ``;

/** Inline style for the chevron background — apply alongside SELECT_CLS. */
export const SELECT_BG_STYLE = {
  backgroundImage: `url("data:image/svg+xml,${CHEVRON_SVG}")`,
  backgroundPosition: "right 0.875rem center",
  backgroundSize: "14px 14px",
} as const;

/** Custom-styled <input> classname for text/date/number inputs. */
export const INPUT_CLS =
  `w-full px-3.5 py-2.5 text-base sm:text-sm bg-white border border-ppp-charcoal-200 rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 hover:border-ppp-charcoal-300 min-h-[44px] transition-colors`;

/** Custom-styled textarea classname. Adds resize-y. */
export const TEXTAREA_CLS =
  `w-full px-3.5 py-2.5 text-base sm:text-sm bg-white border border-ppp-charcoal-200 rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 hover:border-ppp-charcoal-300 resize-y transition-colors`;

/** Label classname — uppercase tracking, charcoal-500. */
export const LABEL_CLS =
  `block text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500 mb-1.5`;
