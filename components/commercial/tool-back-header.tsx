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

export const TOOL_BACK: Record<string, { path: string; label: string }> = {
  "/commercial/post-job/submittals": { path: "/commercial/post-job/submittals", label: "Submittals" },
  "/commercial/post-job/change-orders": { path: "/commercial/post-job/change-orders", label: "Change Orders" },
  "/commercial/post-job/aia": { path: "/commercial/post-job/aia", label: "AIA Billing" },
  "/commercial/post-job/closeout": { path: "/commercial/post-job/closeout", label: "Closeout & Warranty" },
};

/** Resolve the whitelisted back-target from a raw ?back param (or null). */
export function resolveToolBack(back: string | undefined): { path: string; label: string } | null {
  return back ? TOOL_BACK[back] ?? null : null;
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
      <div className="flex items-center gap-2 text-[12px] text-ppp-charcoal-500 flex-wrap">
        <Link href={target.path} className="inline-flex items-center gap-1.5 font-semibold text-cc-brand-700 hover:text-cc-brand-800 min-h-[32px]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M19 12H5 M12 19l-7-7 7-7" /></svg>
          Back to {target.label}
        </Link>
        <span aria-hidden className="text-ppp-charcoal-300">·</span>
        <Link href={`/commercial/accounts/${accountId}?tab=projects&project=${dealId}`} className="truncate hover:text-cc-brand-700 min-h-[32px] inline-flex items-center">
          {accountName} · {dealName}
        </Link>
      </div>
    );
  }
  // From the account Projects tab — classic breadcrumb.
  return (
    <div className="flex items-center gap-2 text-[12px] text-ppp-charcoal-500 flex-wrap">
      <Link href={`/commercial/accounts/${accountId}?tab=projects`} className="inline-flex items-center gap-1 hover:text-cc-brand-700 min-h-[32px]">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M19 12H5 M12 19l-7-7 7-7" /></svg>
        {accountName} · Projects
      </Link>
      <span aria-hidden>/</span>
      <Link href={`/commercial/accounts/${accountId}?tab=projects&project=${dealId}`} className="text-ppp-charcoal-700 font-medium truncate hover:text-cc-brand-700 min-h-[32px] inline-flex items-center">{dealName}</Link>
    </div>
  );
}
