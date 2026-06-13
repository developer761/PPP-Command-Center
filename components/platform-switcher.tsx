"use client";

import { useState } from "react";
import { PLATFORM_SET_ROUTE, type Platform } from "@/lib/platform-cookie";

/**
 * Bottom-left sidebar switcher block.
 *
 * Rendered ONLY when the viewer has access to BOTH platforms — single-access
 * users never see it (parent passes `showSwitcher={false}`). Click swaps
 * platforms via POST /api/platform/set which also updates the sticky
 * cookie so the next fresh tab opens to the platform they're switching to.
 */
export default function PlatformSwitcher({ current }: { current: Platform }) {
  const [busy, setBusy] = useState(false);
  // Internal slug stays `new_platform` (DB column + cookie value); only
  // user-facing label changes — renamed to "Commercial Command Center"
  // (Karan 2026-06-13) so PPP staff can tell the two platforms apart.
  const target: Platform = current === "command_center" ? "new_platform" : "command_center";
  const currentLabel = current === "command_center" ? "Command Center" : "Commercial Command Center";
  const targetLabel = target === "command_center" ? "Command Center" : "Commercial Command Center";

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(PLATFORM_SET_ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: target }),
      });
      if (!res.ok) {
        setBusy(false);
        return;
      }
      const data = (await res.json()) as { redirect?: string };
      window.location.href = data.redirect ?? "/dashboard";
    } catch {
      setBusy(false);
    }
  };

  const accent =
    current === "command_center"
      ? { bg: "bg-emerald-600", hover: "hover:bg-emerald-700", text: "text-emerald-50", small: "text-emerald-100" }
      : { bg: "bg-ppp-blue", hover: "hover:bg-ppp-blue-700", text: "text-ppp-blue-50", small: "text-ppp-blue-100" };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={`Switch to ${targetLabel}`}
      className={`w-full rounded-lg ${accent.bg} ${accent.hover} ${accent.text} px-3 py-2.5 transition-colors disabled:opacity-70`}
    >
      <div className="flex items-center gap-2">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M17 1l4 4-4 4 M3 11V9a4 4 0 0 1 4-4h14 M7 23l-4-4 4-4 M21 13v2a4 4 0 0 1-4 4H3" />
        </svg>
        <div className="flex-1 text-left">
          <div className="text-xs font-semibold leading-tight">{busy ? "Switching…" : `Switch to ${targetLabel}`}</div>
          <div className={`text-[10px] ${accent.small} leading-tight mt-0.5`}>Currently in {currentLabel}</div>
        </div>
      </div>
    </button>
  );
}
