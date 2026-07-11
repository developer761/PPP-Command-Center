/**
 * Horizontal stage-progress strip for a deal.
 *
 * Renders the pipeline stages as a pill row: `Solicitation →
 * Estimating → Proposal Pending → Proposal Sent → Follow-up → Won`.
 * Completed stages fill emerald, the CURRENT stage shows amber "you
 * are here," upcoming stages ghost gray. Terminal statuses (won/lost/
 * no_bid) render a compact closed cap.
 *
 * Karan 2026-07-11 (signature-moments Tier 2): "the color coding on
 * opportunities makes the platform 100x better — see where else we
 * can add features like that." Same idea for deal STAGE: instead of
 * a status pill saying "estimating", show the whole journey so users
 * see how far along they are at a glance.
 *
 * Server component — no client JS. Pure derived render from status.
 */

import type { OpportunityStatus } from "@/lib/commercial/opportunities/db";
import { opportunityStatusLabel } from "@/lib/commercial/opportunities/db";
import { isTerminalOpportunityStatus } from "@/lib/commercial/opportunities/constants";

/**
 * The visible stage sequence for the strip. Terminal states aren't
 * part of the journey — they're the closed cap.
 */
const JOURNEY_STAGES: OpportunityStatus[] = [
  "solicitation",
  "rfp",
  "estimating",
  "proposal_pending_approval",
  "proposal_sent",
  "follow_up",
];

/**
 * Short labels for the pills. `opportunityStatusLabel` returns
 * sentence-case strings like "Proposal pending approval" which is too
 * long for the strip; we tighten these for scanability.
 */
const SHORT_LABEL: Partial<Record<OpportunityStatus, string>> = {
  solicitation: "Sol",
  rfp: "RFP",
  estimating: "Est",
  proposal_pending_approval: "Proposal",
  proposal_sent: "Sent",
  follow_up: "Follow-up",
};

function shortLabel(status: OpportunityStatus): string {
  return SHORT_LABEL[status] ?? opportunityStatusLabel(status);
}

export function DealJourneyStrip({
  status,
  className = "",
}: {
  status: OpportunityStatus;
  className?: string;
}) {
  const isTerminal = isTerminalOpportunityStatus(status);

  if (isTerminal) {
    // Terminal cap — compact rendering. Won = solid emerald cap; lost/
    // no_bid = rose. All stages count as complete since we finished.
    const cap = status === "won"
      ? { bg: "bg-cc-brand-600", text: "text-white", label: "Won" }
      : status === "lost"
      ? { bg: "bg-rose-500", text: "text-white", label: "Lost" }
      : { bg: "bg-ppp-charcoal-500", text: "text-white", label: "No bid" };
    return (
      <div
        className={`inline-flex flex-wrap items-center gap-0.5 gap-y-1 text-[10px] font-semibold ${className}`}
        title={`This deal is closed: ${opportunityStatusLabel(status)}`}
      >
        {JOURNEY_STAGES.map((s) => (
          <span
            key={s}
            className="px-1.5 py-0.5 rounded bg-cc-brand-100 text-cc-brand-700 border border-cc-brand-200"
          >
            {shortLabel(s)}
          </span>
        ))}
        <span aria-hidden className="mx-0.5 text-ppp-charcoal-400">→</span>
        <span
          className={`px-2 py-0.5 rounded ${cap.bg} ${cap.text} font-bold`}
        >
          {cap.label}
        </span>
      </div>
    );
  }

  const currentIdx = JOURNEY_STAGES.indexOf(status);

  return (
    <div
      className={`inline-flex flex-wrap items-center gap-0.5 gap-y-1 text-[10px] font-semibold ${className}`}
      title={`Current stage: ${opportunityStatusLabel(status)}`}
    >
      {JOURNEY_STAGES.map((s, i) => {
        const isComplete = i < currentIdx;
        const isCurrent = i === currentIdx;
        const tone = isCurrent
          ? "bg-amber-100 text-amber-900 border-amber-300 ring-1 ring-amber-200"
          : isComplete
          ? "bg-cc-brand-100 text-cc-brand-800 border-cc-brand-200"
          : "bg-white text-ppp-charcoal-400 border-ppp-charcoal-200";
        return (
          <span
            key={s}
            className={`px-1.5 py-0.5 rounded border ${tone}`}
            aria-current={isCurrent ? "step" : undefined}
          >
            {shortLabel(s)}
          </span>
        );
      })}
    </div>
  );
}
