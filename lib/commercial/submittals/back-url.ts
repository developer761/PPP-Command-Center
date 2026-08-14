/**
 * Back-button URL handling for the submittal detail page.
 *
 * Extracted from the page (round-3 handoff #1, 2026-08-14) so the rule can be
 * tested — it was wrong in a way that only shows up after an action redirect.
 */

/**
 * Open-redirect-guarded origin for the Back button. Only a relative
 * `/commercial/` path is honoured (the submittals index and the deal page both
 * pass one when you drill in); anything else falls back to no back context.
 */
export function safeBack(raw: string | undefined | null): string | null {
  return raw && raw.startsWith("/commercial/") ? raw : null;
}

/**
 * Re-attach the origin to an ACTION redirect so the Back button survives the
 * round-trip. The action ALWAYS returns to `url` — the submittal's own detail
 * page, where the user stays to keep working — with `back` carried as a
 * `?back=` param so Back still returns to wherever they came from.
 *
 * ROUND-3 HANDOFF #1 (2026-08-14): the previous version special-cased a
 * deal-origin `back` (a `/commercial/accounts/<id>?tab=projects&project=<id>`
 * drill-in, or a `/commercial/opportunities/<id>` deal page) and redirected to
 * it VERBATIM, on the premise that "the detail renders there". It does not —
 * those URLs render the submittals LIST — so every action (add an item, save
 * the cover letter) ejected the user to the list, and adding four items meant
 * re-opening the submittal four times. An action redirect is not a breadcrumb:
 * it goes to `url`, and `back` is only ever a param on it.
 */
export function withBack(url: string, back: string | null): string {
  if (!back) return url;
  return `${url}${url.includes("?") ? "&" : "?"}back=${encodeURIComponent(back)}`;
}
