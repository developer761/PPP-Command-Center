"use client";

import { useState } from "react";
import {
  PLATFORM_SET_ROUTE,
  PLATFORM_LABEL,
  type Platform,
} from "@/lib/platform-cookie";

/**
 * Bottom-left sidebar switcher block.
 *
 * Rendered only for viewers with more than one platform — single-access users
 * never see it (the sidebar checks `accessible.length > 1`). Clicking swaps
 * platforms via POST /api/platform/set, which also updates the sticky cookie
 * so the next fresh tab opens where they switched to.
 *
 * Takes the viewer's accessible platforms rather than assuming there are
 * exactly two. The previous version computed its target as "the other one",
 * which is only meaningful while the count is two — a third platform would
 * have made it silently pick one and hide the rest.
 *
 * ONE LINE, deliberately (Karan 2026-09-01: "too bulky and big cause now we
 * have messaging"). It used to stack "Switch to X" over "Currently in Y" in a
 * padded slab — about 90px of sidebar, with a separator and a PLATFORMS
 * heading above it, to hold a single link. The second line was redundant: the
 * sidebar a reader is looking at is already branded to the platform they are
 * in, so it spent a line answering a question the whole page answers. The
 * destination name carries the row now; "Switch to …" survives as the
 * aria-label, where the verb is the part a screen reader actually needs.
 */
export default function PlatformSwitcher({
  current,
  accessible,
}: {
  current: Platform;
  accessible: Platform[];
}) {
  const [busy, setBusy] = useState<Platform | null>(null);
  const targets = accessible.filter((p) => p !== current);
  if (targets.length === 0) return null;

  const go = async (target: Platform) => {
    if (busy) return;
    setBusy(target);
    try {
      const res = await fetch(PLATFORM_SET_ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: target }),
      });
      if (!res.ok) {
        setBusy(null);
        return;
      }
      const data = (await res.json()) as { redirect?: string };
      window.location.href = data.redirect ?? "/dashboard";
    } catch {
      setBusy(null);
    }
  };

  // Tint by the CURRENT platform's canonical accent so it matches the rest of
  // that platform's chrome. Karan 2026-07-27 audit: the commercial side used
  // ppp-blue, but blue is the RESIDENTIAL signal (bell) and cc-brand (red) is
  // the commercial accent — so inside commercial the switcher read off-brand.
  // Solid colored button → white text in BOTH themes. (Tint shades like
  // text-cc-brand-50 broke in dark: those flip to a dark tint = dark-on-dark.)
  const accent =
    current === "command_center"
      ? { bg: "bg-emerald-600", hover: "hover:bg-emerald-700", text: "text-white" }
      : { bg: "bg-cc-brand-600", hover: "hover:bg-cc-brand-700", text: "text-white" };

  return (
    <div className="flex flex-col gap-1">
      {targets.map((target) => (
        <button
          key={target}
          type="button"
          onClick={() => go(target)}
          disabled={busy !== null}
          aria-label={`Switch to ${PLATFORM_LABEL[target]}`}
          title={`Switch to ${PLATFORM_LABEL[target]}`}
          className={`flex w-full items-center gap-2 rounded-lg ${accent.bg} ${accent.hover} ${accent.text} px-3 py-2 min-h-[44px] sm:min-h-0 transition-colors disabled:opacity-70 touch-manipulation`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
            <path d="M17 1l4 4-4 4 M3 11V9a4 4 0 0 1 4-4h14 M7 23l-4-4 4-4 M21 13v2a4 4 0 0 1-4 4H3" />
          </svg>
          {/* truncate, not wrap — a long platform name re-introduces the second
              line this component exists to have removed. */}
          <span className="min-w-0 flex-1 truncate text-left text-xs font-semibold leading-tight">
            {busy === target ? "Switching…" : PLATFORM_LABEL[target]}
          </span>
        </button>
      ))}
    </div>
  );
}
