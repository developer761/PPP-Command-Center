"use client";

import type { TourStep } from "@/components/commercial/onboarding-walkthrough";

/**
 * "Try it out" — starts the guided walkthrough on the REAL page.
 *
 * Karan 2026-09-16: "instead of Open it, have Try it out, and it literally
 * takes you through each platform in walkthrough mode — no changes can be made,
 * but it shows you how to do stuff and where."
 *
 * It reuses the onboarding tour engine mounted in the commercial layout rather
 * than opening a second one. Two reasons that matters: the engine already
 * survives client-side navigation (it lives in the layout, so a step can push a
 * route and keep going), and its overlay already sits over the whole app with
 * every click landing on the overlay rather than the page underneath. The
 * read-only promise is therefore structural — there is no interactive surface
 * to reach — rather than a list of handlers somebody has to remember to add.
 */
export function TourButton({
  steps,
  label,
  children,
  variant = "secondary",
}: {
  steps: TourStep[];
  /** Shown in the tour card's counter, e.g. "Mary's day". */
  label?: string;
  children: React.ReactNode;
  variant?: "primary" | "secondary";
}) {
  const cls =
    variant === "primary"
      ? "inline-flex items-center gap-1.5 rounded-lg bg-cc-brand-600 text-white px-3.5 min-h-[40px] text-[13px] font-semibold hover:bg-cc-brand-700 transition-colors"
      : "inline-flex items-center gap-1.5 rounded-lg border border-ppp-charcoal-200 bg-surface px-3 min-h-[38px] text-[12.5px] font-semibold text-cc-brand-700 hover:bg-ppp-charcoal-50 hover:border-cc-brand-300 transition-colors";

  return (
    <button
      type="button"
      className={cls}
      onClick={() =>
        window.dispatchEvent(new CustomEvent("cc:start-tour", { detail: { steps, label } }))
      }
    >
      {children}
    </button>
  );
}
