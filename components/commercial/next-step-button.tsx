import Link from "next/link";
import type { NextStep } from "@/lib/commercial/opportunities/attention";
import { moveOpportunityStatusAction } from "@/lib/commercial/opportunities/status-actions";
import { SubmitButton } from "@/components/commercial/submit-button";

/**
 * The "what do I do next" button.
 *
 * Karan 2026-08-12: *"there is like a Start Project button when an opp is won
 * which is great — we need more of that so people know what to do."*
 * Then 2026-08-13: *"when I click Move it to Estimating it should move the
 * status, it doesn't right now — it just brings me to change status. Same with
 * mark as won or lost, it should bring a popup."*
 *
 * So a step renders as one of three things, decided by what it KNOWS:
 *
 *  - `move` — one destination, nothing left to ask. Posts the status change
 *    on click. A form to re-select the answer already in the label is a wasted
 *    click, and reads as the button not working.
 *  - `choose` — a real question (won vs lost). Both answers, side by side,
 *    each posting directly. No dropdown to find.
 *  - `href` — the work happens somewhere else (build a proposal, bill it), so
 *    it navigates.
 *
 * The choice popover is a `<details>`, so it costs no JS and works before
 * hydration — the same reason the saved-view picker is one.
 */

export function NextStepButton({
  step,
  size = "sm",
  oppId,
  className = "",
}: {
  step: NextStep | null;
  size?: "sm" | "lg";
  /** Required for a `move` or `choose` step — it is what gets posted. */
  oppId?: string;
  className?: string;
}) {
  if (!step) return null;

  const lg = size === "lg";
  const solid = lg
    ? "inline-flex items-center gap-1.5 h-11 px-4 rounded-lg bg-cc-brand-600 text-white text-[13px] font-bold hover:bg-cc-brand-700 transition-colors"
    : "inline-flex items-center gap-1 min-h-[44px] sm:min-h-[26px] px-2.5 rounded-lg border border-cc-brand-300 text-cc-brand-700 text-[11.5px] font-bold whitespace-nowrap hover:bg-cc-brand-600 hover:border-cc-brand-600 hover:text-white transition-colors";

  // ── A real question: offer both answers ────────────────────────────────
  if (step.choose && oppId) {
    return (
      <details className={`relative inline-block ${className}`}>
        <summary className={`${solid} list-none cursor-pointer`} title={step.why}>
          {step.label}
          <Arrow />
        </summary>
        <div className="absolute z-30 mt-1.5 right-0 w-44 rounded-xl border border-ppp-charcoal-200 bg-surface shadow-lg overflow-hidden">
          {step.choose.map((c) => (
            <form key={c.label} action={moveOpportunityStatusAction}>
              <input type="hidden" name="opp_id" value={oppId} />
              <input type="hidden" name="to_status" value={c.to} />
              <input type="hidden" name="to_sub_status" value={c.sub} />
              <SubmitButton
                pendingLabel="Saving…"
                className={`w-full text-left px-3.5 py-2 min-h-[44px] text-[12.5px] font-semibold hover:bg-ppp-charcoal-50 ${
                  c.tone === "good" ? "text-emerald-700" : "text-rose-700"
                }`}
              >
                {c.label}
              </SubmitButton>
            </form>
          ))}
        </div>
      </details>
    );
  }

  // ── One destination: just do it ────────────────────────────────────────
  if (step.move && oppId) {
    return (
      <form action={moveOpportunityStatusAction} className={`inline-block ${className}`}>
        <input type="hidden" name="opp_id" value={oppId} />
        <input type="hidden" name="to_status" value={step.move.to} />
        {step.move.sub && <input type="hidden" name="to_sub_status" value={step.move.sub} />}
        <SubmitButton pendingLabel="Moving…" className={solid} title={step.why}>
          {step.label}
        </SubmitButton>
      </form>
    );
  }

  // ── The work is elsewhere: go there ────────────────────────────────────
  return (
    <Link href={step.href} title={step.why} className={`${solid} ${className}`}>
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
