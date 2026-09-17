/**
 * Where a job link on an Accounting tab should GO, and how to get back.
 *
 * Karan 2026-09-16: "let's say I go onto purchases and click a job — I want it
 * to bring me to the place where I can put purchases, and same with the other
 * tabs, and then a back button so I can cleanly go back to the accounting page."
 *
 * Two halves, and both matter:
 *  - the DESTINATION is the surface that does the job, not the deal's front
 *    page. From Purchases you land in the costs tool, with the form on screen.
 *  - the RETURN is the tab you left, carried as `?back=`. The deal page
 *    whitelists it (`resolveToolBack`) and renders it as the one back control.
 *
 * It lives here rather than inline because four tabs need it and the encoding
 * is the kind of detail that drifts: one tab spelling the path differently is
 * one tab whose back button silently stops resolving.
 */

/** The Accounting tab to return to, encoded for `?back=`. */
export function accountingBack(view: string): string {
  return encodeURIComponent(`/commercial/accounting?view=${view}`);
}

/** The costs tool on a deal — where purchases and labor payments get recorded. */
export function costToolHref(oppId: string | null, fromView: string): string | null {
  if (!oppId) return null;
  // Straight to the tool. `/accounts/<id>/costs/<deal>` looks like the right
  // address and is a REDIRECT that forwards here — a round-trip, and on screen
  // indistinguishable from linking at the deal page, which is what it felt like.
  return `/commercial/opportunities/${oppId}?tab=project&sub=transactions&back=${accountingBack(fromView)}`;
}

/** The deal's invoices + payments — where money coming IN gets recorded. */
export function moneyInHref(oppId: string | null, fromView: string): string | null {
  if (!oppId) return null;
  return `/commercial/opportunities/${oppId}?tab=invoices&back=${accountingBack(fromView)}`;
}
