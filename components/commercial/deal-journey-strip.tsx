/**
 * Horizontal stage-progress strip for a deal — v2 (2026-07-13 Katie's
 * Pre-Sale / Post-Sale two-lane model).
 *
 * Renders TWO rows:
 *   Pre-Sale:  Qualifying → Estimating → Proposal → Closed (Won/Lost)
 *   Post-Sale: Pre-Construction → In Progress → Billing → Closed
 * (Post-Sale row only appears once the deal is Won or beyond.)
 *
 * Sub-status is shown as a small chip beneath the ACTIVE pill so
 * "Qualifying / RFP" reads as a two-line stack in one glance.
 *
 * Server component — no client JS. Pure derived render from
 * (status, sub_status).
 */

import {
  laneForStatus,
  isWon,
  isLost,
  PRE_SALE_STATUSES,
  POST_SALE_STATUSES,
  opportunitySubStatusLabel,
  type OpportunityStatus,
} from "@/lib/commercial/opportunities/constants";

const PRE_SALE_SHORT: Record<string, string> = {
  qualifying: "Qualify",
  estimating: "Estimate",
  proposal: "Proposal",
  pre_sale_closed: "Closed",
};

const POST_SALE_SHORT: Record<string, string> = {
  pre_construction: "Pre-Con",
  in_progress: "WIP",
  billing: "Billing",
  post_sale_closed: "Closed",
};

function pillClass(state: "complete" | "current" | "future" | "lost-cap") {
  switch (state) {
    case "complete":
      return "bg-cc-brand-100 text-cc-brand-800 border-cc-brand-200";
    case "current":
      return "bg-amber-100 text-amber-900 border-amber-300 ring-1 ring-amber-200";
    case "future":
      return "bg-white text-ppp-charcoal-400 border-ppp-charcoal-200";
    case "lost-cap":
      return "bg-rose-500 text-white border-rose-500";
  }
}

/**
 * Render one lane (Pre-Sale or Post-Sale) as a pill row + optional
 * sub-status chip underneath the ACTIVE pill.
 */
function LaneRow({
  stages,
  labels,
  currentIdx,
  activeSubStatus,
  isLostCap,
}: {
  stages: readonly OpportunityStatus[];
  labels: Record<string, string>;
  currentIdx: number;
  activeSubStatus: string | null | undefined;
  isLostCap: boolean;
}) {
  return (
    <div className="inline-flex flex-wrap items-center gap-0.5 gap-y-1 text-[10px] font-semibold">
      {stages.map((s, i) => {
        // Final pill in a lost-cap lane renders rose regardless of index.
        const isFinalPill = i === stages.length - 1;
        let state: "complete" | "current" | "future" | "lost-cap";
        if (isLostCap && isFinalPill) state = "lost-cap";
        else if (i < currentIdx) state = "complete";
        else if (i === currentIdx) state = "current";
        else state = "future";
        return (
          <span
            key={s}
            className={`px-1.5 py-0.5 rounded border ${pillClass(state)}`}
            aria-current={i === currentIdx ? "step" : undefined}
          >
            {labels[s] ?? s}
          </span>
        );
      })}
      {activeSubStatus && (
        <span className="ml-1 px-1 py-0 rounded bg-ppp-charcoal-50 border border-ppp-charcoal-100 text-[9.5px] font-medium text-ppp-charcoal-600 tracking-wide">
          {opportunitySubStatusLabel(activeSubStatus)}
        </span>
      )}
    </div>
  );
}

export function DealJourneyStrip({
  status,
  sub_status,
  className = "",
}: {
  status: OpportunityStatus | string;
  sub_status?: string | null;
  className?: string;
}) {
  const lane = laneForStatus(status);
  const preIdx = (PRE_SALE_STATUSES as readonly string[]).indexOf(status);
  const postIdx = (POST_SALE_STATUSES as readonly string[]).indexOf(status);

  // Post-Sale row visibility: only render once the deal has moved past
  // Pre-Sale/Closed/Won into Post-Sale. Losing a bid stops at Pre-Sale.
  const showPostSaleRow = lane === "post_sale";
  const oppTuple = { status, sub_status };

  // Pre-Sale row rendering
  const preSaleActiveIdx =
    lane === "pre_sale" ? preIdx : PRE_SALE_STATUSES.length - 1;
  const preSaleLostCap =
    lane === "pre_sale" && isLost(oppTuple);
  const showPreSaleSubStatus =
    lane === "pre_sale" && sub_status && !isLost(oppTuple) && !isWon(oppTuple);

  return (
    <div className={`inline-flex flex-col gap-1 ${className}`}>
      <LaneRow
        stages={PRE_SALE_STATUSES}
        labels={PRE_SALE_SHORT}
        currentIdx={preSaleActiveIdx}
        activeSubStatus={showPreSaleSubStatus ? sub_status ?? null : null}
        isLostCap={preSaleLostCap}
      />
      {showPostSaleRow && (
        <LaneRow
          stages={POST_SALE_STATUSES}
          labels={POST_SALE_SHORT}
          currentIdx={postIdx}
          activeSubStatus={sub_status ?? null}
          isLostCap={false}
        />
      )}
    </div>
  );
}
