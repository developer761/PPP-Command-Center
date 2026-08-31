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
 * have made it silently pick one and hide the rest. With one target the markup
 * is identical to what it has always rendered.
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
      ? { bg: "bg-emerald-600", hover: "hover:bg-emerald-700", text: "text-white", small: "text-white/70" }
      : { bg: "bg-cc-brand-600", hover: "hover:bg-cc-brand-700", text: "text-white", small: "text-white/70" };

  return (
    <div className="flex flex-col gap-1.5">
      {targets.map((target) => (
        <button
          key={target}
          type="button"
          onClick={() => go(target)}
          disabled={busy !== null}
          aria-label={`Switch to ${PLATFORM_LABEL[target]}`}
          className={`w-full rounded-lg ${accent.bg} ${accent.hover} ${accent.text} px-3 py-2.5 transition-colors disabled:opacity-70`}
        >
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M17 1l4 4-4 4 M3 11V9a4 4 0 0 1 4-4h14 M7 23l-4-4 4-4 M21 13v2a4 4 0 0 1-4 4H3" />
            </svg>
            <div className="flex-1 text-left">
              <div className="text-xs font-semibold leading-tight">
                {busy === target ? "Switching…" : `Switch to ${PLATFORM_LABEL[target]}`}
              </div>
              <div className={`text-[10px] ${accent.small} leading-tight mt-0.5`}>
                Currently in {PLATFORM_LABEL[current]}
              </div>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
