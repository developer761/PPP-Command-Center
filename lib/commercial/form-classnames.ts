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
  `w-full appearance-none cursor-pointer pl-3.5 pr-10 py-2.5 text-base sm:text-sm bg-surface border border-ppp-charcoal-200 rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 hover:border-ppp-charcoal-300 min-h-[44px] transition-colors bg-no-repeat ` +
  // Background-image must live in style prop (Tailwind can't process
  // URL-encoded SVG inside arbitrary values reliably). See INPUT_BG_STYLE.
  ``;

/** Inline style for the chevron background — apply alongside SELECT_CLS.
 *  Karan 2026-07-10: `backgroundRepeat: "no-repeat"` is CRITICAL — without
 *  it, Safari + Chrome tile the SVG chevron across the entire select
 *  width (~20 chevrons in a horizontal row). Consumers that use their
 *  OWN classname (not SELECT_CLS) still get the fix from this one line
 *  because the inline style overrides CSS, so we don't have to hunt down
 *  every classname. */
export const SELECT_BG_STYLE = {
  backgroundImage: `url("data:image/svg+xml,${CHEVRON_SVG}")`,
  backgroundPosition: "right 0.875rem center",
  backgroundSize: "14px 14px",
  backgroundRepeat: "no-repeat",
} as const;

/** Custom-styled <input> classname for text/date/number inputs. */
export const INPUT_CLS =
  `w-full px-3.5 py-2.5 text-base sm:text-sm bg-surface border border-ppp-charcoal-200 rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 hover:border-ppp-charcoal-300 min-h-[44px] transition-colors`;

/** Custom-styled textarea classname. Adds resize-y. */
export const TEXTAREA_CLS =
  `w-full px-3.5 py-2.5 text-base sm:text-sm bg-surface border border-ppp-charcoal-200 rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 hover:border-ppp-charcoal-300 resize-y transition-colors`;

/** Label classname — warm sentence-case, charcoal-800. Karan 2026-07-09:
 *  the old uppercase tracked-gray look reads like an AI form generator.
 *  Sentence-case + darker weight looks intentional and hand-crafted. */
export const LABEL_CLS =
  `block text-[13px] font-semibold text-ppp-charcoal-800 mb-1.5`;

/**
 * The COMPACT variant, for a filter bar rather than a form field.
 *
 * Same contract — `appearance-none` plus our own chevron, so no surface on the
 * platform ever shows the OS's grey dropdown chrome — but sized to sit in a row
 * of controls instead of filling a column. Karan has now flagged the grey
 * native select FOUR times; a filter bar that hand-rolls its own classes is
 * exactly how the fifth happens.
 *
 * Pair with `SELECT_BG_STYLE_COMPACT`, which pulls the chevron in to match the
 * tighter right padding.
 */
export const FILTER_SELECT_CLS =
  "appearance-none cursor-pointer pl-2.5 pr-7 py-1.5 text-base sm:text-[12.5px] font-semibold text-ppp-charcoal bg-surface border border-ppp-charcoal-200 rounded-lg shadow-sm hover:border-ppp-charcoal-300 focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 min-h-[44px] sm:min-h-[36px] bg-no-repeat transition-colors max-w-[190px] truncate";

/** Chevron for FILTER_SELECT_CLS. `backgroundRepeat` is load-bearing — without
 *  it Safari and Chrome tile the SVG across the whole control. */
export const SELECT_BG_STYLE_COMPACT = {
  backgroundImage: `url("data:image/svg+xml,${CHEVRON_SVG}")`,
  backgroundPosition: "right 0.5rem center",
  backgroundSize: "12px 12px",
  backgroundRepeat: "no-repeat",
} as const;
