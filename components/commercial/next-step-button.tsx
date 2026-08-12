import Link from "next/link";
import type { NextStep } from "@/lib/commercial/opportunities/attention";

/**
 * The "what do I do next" button, rendered wherever a deal appears.
 *
 * Karan 2026-08-12: *"there is like a Start Project button when an opp is won
 * which is great — we need more of that so people know what to do / where to
 * go easily for their next step."*
 *
 * `nextStep` decides the label and the destination; this only draws it. Two
 * sizes, because the same answer has to fit three very different surfaces:
 *
 *  - `lg` — the deal page, where it is the primary call to action.
 *  - `sm` — a pipeline row or a dashboard line, where it sits beside the deal
 *    it belongs to and must not out-shout the deal's own name.
 *
 * Both are ≥44px on touch. A button whose whole purpose is "tap this next" is
 * the last one that should be hard to hit.
 *
 * Deliberately quiet styling on `sm`: a list of twenty deals with twenty solid
 * orange buttons reads as an error state, not as guidance. Outlined by default,
 * filling in on hover — present when looked for, invisible when scanning.
 */
export function NextStepButton({
  step,
  size = "sm",
  className = "",
}: {
  step: NextStep | null;
  size?: "sm" | "lg";
  className?: string;
}) {
  if (!step) return null;

  if (size === "lg") {
    return (
      <Link
        href={step.href}
        title={step.why}
        className={`inline-flex items-center gap-1.5 h-11 px-4 rounded-lg bg-cc-brand-600 text-white text-[13px] font-bold hover:bg-cc-brand-700 transition-colors ${className}`}
      >
        {step.label}
        <Arrow />
      </Link>
    );
  }

  return (
    <Link
      href={step.href}
      title={step.why}
      className={`inline-flex items-center gap-1 min-h-[44px] sm:min-h-[26px] px-2.5 rounded-lg border border-cc-brand-300 text-cc-brand-700 text-[11.5px] font-bold whitespace-nowrap hover:bg-cc-brand-600 hover:border-cc-brand-600 hover:text-white transition-colors ${className}`}
    >
      {step.label}
      <Arrow />
    </Link>
  );
}

function Arrow() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0"
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}
