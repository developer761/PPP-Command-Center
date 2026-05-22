"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useViewer } from "@/lib/auth/viewer-context";

type Props = {
  /** Is the (scoped) snapshot completely empty for this viewer? */
  empty: boolean;
};

/**
 * Shown when the viewer is in "my" scope (rep, or admin who toggled / picked
 * View As) and the resulting snapshot is empty. Without this, an admin who
 * clicks "My" with no SF mapping sees a blank dashboard and assumes the app
 * is broken.
 *
 * Always-active on the page (no dismiss) — the page itself is mostly empty,
 * so the banner is the only signal.
 */
export default function EmptyScopeBanner({ empty }: Props) {
  const viewer = useViewer();
  const pathname = usePathname();
  const params = useSearchParams();
  if (!viewer || !empty) return null;
  if (viewer.scope !== "my") return null;

  const switchToAll = () => {
    if (typeof window === "undefined") return "/dashboard";
    const next = new URLSearchParams(params?.toString() ?? "");
    next.delete("view_as");
    next.delete("scope");
    const qs = next.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  // Distinguish the two reasons we landed in "my" with no data:
  //   (a) admin with no SF rep mapping AND no view_as → can flip to All
  //   (b) impersonating an inactive / empty rep
  //   (c) a real rep whose data simply hasn't loaded yet
  const message = viewer.isAdmin && !viewer.viewAsUserId && !viewer.sfUserId
    ? "Your account isn't linked to a Salesforce rep, so 'My' shows nothing. Switch to 'All' to see the full pipeline."
    : viewer.isAdmin && viewer.viewAsUserId
      ? `${viewer.viewAsName ?? "This rep"} doesn't have any data in the current period.`
      : "We couldn't find any work orders or opportunities assigned to you. Check with your admin to confirm your Salesforce rep mapping.";

  return (
    <div className="mb-6 rounded-xl border border-ppp-blue-100 bg-ppp-blue-50 px-4 py-3 flex items-start gap-3">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ppp-blue mt-0.5 shrink-0" aria-hidden>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4 M12 8h.01" />
      </svg>
      <div className="text-[12px] sm:text-[13px] text-ppp-charcoal-700 flex-1 min-w-0">
        <div className="font-semibold text-ppp-charcoal">No data for this view</div>
        <div className="mt-0.5">{message}</div>
      </div>
      {viewer.isAdmin && (
        <Link
          href={switchToAll()}
          className="shrink-0 self-center inline-flex px-3 py-1.5 rounded-full bg-white border border-ppp-blue-200 text-[11px] font-medium text-ppp-blue-700 hover:bg-ppp-blue-100 transition-colors"
        >
          Switch to All
        </Link>
      )}
    </div>
  );
}
