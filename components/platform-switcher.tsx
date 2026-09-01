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

  // GHOST ROW, not a colour block (Karan 2026-09-01, after a solid emerald and
  // then a solid forest both read too heavy): transparent, hairline border,
  // muted label — the same visual weight as the nav items above it. Colour
  // arrives only on hover.
  //
  // The resting styles are all neutral charcoal tokens, which already invert
  // correctly for the commercial dark theme (label 7.30:1 on white, 11.74:1 on
  // the dark column). The hairline is deliberately below the 3:1 that WCAG
  // asks of a boundary — it is decorative here, because the icon and the label
  // identify this control, not its edge.
  //
  // Hover accent differs per platform so the switcher still reads as part of
  // the chrome it sits in: forest in residential, cc-brand in commercial.
  // Both use the -700 role rather than -600: cc-brand-600 on its own -50 tint
  // is 3.32:1 light and 2.70:1 dark, under AA for a 12px semibold label.
  // cc-brand-700 is the token already designated for nav text — 4.75:1 and
  // 6.56:1 — and forest-500 is the equivalent accent on the residential side.
  const hover =
    current === "command_center"
      ? "hover:bg-ppp-forest-50 hover:border-ppp-forest-200 hover:text-ppp-forest-500"
      : "hover:bg-cc-brand-50 hover:border-cc-brand-200 hover:text-cc-brand-700";

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
          className={`group flex w-full items-center gap-2 rounded-lg border border-ppp-charcoal-200 bg-transparent px-3 py-2 min-h-[44px] sm:min-h-0 text-ppp-charcoal-600 ${hover} transition-colors disabled:opacity-60 touch-manipulation`}
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
