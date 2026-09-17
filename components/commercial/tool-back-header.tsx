/**
 * ToolBackHeader — the context-aware header row on the four account-scoped
 * production-tool pages (Change Orders / AIA / Submittals / Closeout).
 *
 * Two modes, so a tool page feels like it belongs wherever you came from:
 *  - Reached from a SIDEBAR TOOL TAB (?back=/commercial/post-job/<tool>): show
 *    "← Back to <Tool>" pointing at that tool's index, and keep the account +
 *    deal as a small secondary line. The sidebar tool tab stays highlighted, so
 *    it reads like the Invoices tab — one page, back arrow to the index.
 *  - Reached from the account Projects tab (no ?back): the classic
 *    "<Account> · Projects / <Deal>" breadcrumb.
 *
 * `back` is whitelisted against TOOL_BACK — never trusted raw — so it can't be
 * an open-redirect / arbitrary href.
 */
import Link from "next/link";

import { savedViewHref } from "@/lib/commercial/opportunities/saved-views";

/**
 * THE KEY IS THE OLD URL. THE PATH IS WHERE IT ACTUALLY GOES.
 *
 * Karan 2026-09-17: "sometimes the platform is glitchy and when I click back it
 * brings me to like an old retiree page."
 *
 * This was it, and it was literal. Every one of these six `path` values used to
 * be the `/commercial/post-job/*` route itself — and all six of those routes
 * were retired in the 2026-08 restructure and now do nothing but `redirect()`
 * to a saved view. So the button reading "← Back to AIA Billing" navigated to a
 * dead page, which bounced you to a filtered list. Two entries in history for a
 * place you never meant to stop, and pressing Back again put you right back on
 * the redirect.
 *
 * The keys must STAY as the old paths — that is the `?back=` value already
 * travelling in bookmarks, bell notifications and sent email, and it is what
 * the whitelist matches on. Only the destination changes, so an old link now
 * lands in one hop on the page that replaced the index.
 *
 * Kept in step with app/commercial/post-job/<tool>/page.tsx, which redirect to
 * exactly these saved views.
 */
export const TOOL_BACK: Record<string, { path: string; label: string }> = {
  "/commercial/post-job/submittals": { path: savedViewHref("under_contract"), label: "Submittals" },
  "/commercial/post-job/change-orders": { path: savedViewHref("under_contract"), label: "Change Orders" },
  "/commercial/post-job/aia": { path: savedViewHref("billing"), label: "AIA Billing" },
  "/commercial/post-job/closeout": { path: savedViewHref("billing"), label: "Closeout & Warranty" },
  "/commercial/post-job/costs": { path: savedViewHref("under_contract"), label: "Transactions" },
  "/commercial/post-job/work-orders": { path: savedViewHref("active_projects"), label: "Work Orders" },
};

/** The deal-scoped Invoices page (`/commercial/invoices/new?opp=<uuid>`) is a
 *  legitimate back-target when a tool is opened from that page's Margin tile.
 *  It can't be a static whitelist key (the opp is dynamic), so match the exact
 *  shape — internal path + a UUID opp — which keeps the open-redirect guard. */
const INVOICE_DEAL_BACK_RE =
  /^\/commercial\/invoices\/new\?opp=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The deal drill-in itself — `/commercial/accounts/<uuid>?tab=projects&project=<uuid>`
 *  with an optional `&dt=<tool>`. This is where a deal's tools actually live, so
 *  it is the most important back-target of all, and it was the one target the
 *  whitelist didn't accept: every link that carried it was silently dropped and
 *  fell through to a generic breadcrumb. Same dynamic-UUID shape as the invoice
 *  case above, so the open-redirect guard is unchanged. */
const DEAL_DRILL_IN_BACK_RE =
  /^\/commercial\/accounts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\?tab=projects&project=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(&dt=[a-z-]+)?(#[a-z-]+)?$/i;

/** The OPPORTUNITY page — where a deal's tools live as of restructure step 3
 *  (Karan 2026-08-12). Added in the same commit that moved them, deliberately:
 *  the last time this whitelist lagged the surface it described, every link
 *  carrying the new shape was silently dropped and fell back to a generic
 *  breadcrumb, with nothing to indicate the back button had stopped working.
 *
 *  Shape: `/commercial/opportunities/<uuid>` with an optional `?tab=` /
 *  `&sub=` and an optional anchor. Anchored at both ends and restricted to
 *  known-safe characters, so the open-redirect guard is unchanged — `?back=`
 *  becomes an href and must never accept an arbitrary URL. */
const OPPORTUNITY_BACK_RE =
  /^\/commercial\/opportunities\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\?tab=[a-z-]+(&sub=[a-z-]+)?)?(#[a-z-]+)?$/i;

/** ACCOUNTING — a tab on /commercial/accounting.
 *
 *  Karan 2026-09-16: clicking a job on the Purchases tab landed on the deal
 *  page, which is not where you add a purchase, and there was no way back to
 *  the tab you came from. The job link now opens the cost tool directly and
 *  carries the tab as its back-target, so it is one hop there and one hop back.
 *
 *  Restricted to a known view key — `?back=` becomes an href and must never
 *  accept an arbitrary URL. */
const ACCOUNTING_BACK_RE = /^\/commercial\/accounting(\?view=[a-z-]{1,20})?$/i;

const ACCOUNTING_LABELS: Record<string, string> = {
  purchases: "Purchases",
  "labor-out": "Labor payments",
  deposits: "Deposits",
  receivables: "Receivables",
  ar: "AR sheet",
  owed: "Balance owed",
  costs: "Job costs",
  transactions: "Transactions",
};

/** Resolve the whitelisted back-target from a raw ?back param (or null). */
export function resolveToolBack(back: string | undefined): { path: string; label: string } | null {
  if (!back) return null;
  if (TOOL_BACK[back]) return TOOL_BACK[back];
  if (INVOICE_DEAL_BACK_RE.test(back)) return { path: back, label: "Invoices" };
  if (ACCOUNTING_BACK_RE.test(back)) {
    const view = back.split("view=")[1] ?? "";
    return { path: back, label: ACCOUNTING_LABELS[view] ?? "Accounting" };
  }
  if (DEAL_DRILL_IN_BACK_RE.test(back)) return { path: back, label: "Opportunity" };
  if (OPPORTUNITY_BACK_RE.test(back)) return { path: back, label: "Opportunity" };
  return null;
}

export function ToolBackHeader({
  accountId,
  dealId,
  accountName,
  dealName,
  back,
}: {
  accountId: string;
  dealId: string;
  accountName: string;
  dealName: string;
  back?: string;
}) {
  const target = resolveToolBack(back);
  if (target) {
    return (
      <div data-tool-back className="flex items-center gap-2 text-[12px] text-ppp-charcoal-500 flex-wrap">
        <Link href={target.path} className="inline-flex items-center gap-1.5 font-semibold text-cc-brand-700 hover:text-cc-brand-800 min-h-[44px] sm:min-h-[32px]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M19 12H5 M12 19l-7-7 7-7" /></svg>
          Back to {target.label}
        </Link>
        <span aria-hidden className="text-ppp-charcoal-300">·</span>
        <Link href={`/commercial/opportunities/${dealId}`} className="truncate hover:text-cc-brand-700 min-h-[44px] sm:min-h-[32px] inline-flex items-center">
          {accountName} · {dealName}
        </Link>
      </div>
    );
  }
  // From the account Projects tab — classic breadcrumb.
  return (
    <div className="flex items-center gap-2 text-[12px] text-ppp-charcoal-500 flex-wrap">
      <Link href={`/commercial/accounts/${accountId}?tab=deals`} className="inline-flex items-center gap-1 hover:text-cc-brand-700 min-h-[44px] sm:min-h-[32px]">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M19 12H5 M12 19l-7-7 7-7" /></svg>
        {accountName} · Projects
      </Link>
      <span aria-hidden>/</span>
      <Link href={`/commercial/opportunities/${dealId}`} className="text-ppp-charcoal-700 font-medium truncate hover:text-cc-brand-700 min-h-[44px] sm:min-h-[32px] inline-flex items-center">{dealName}</Link>
    </div>
  );
}
