/**
 * Horizontal stage-progress strip for a deal — v2 (2026-07-13 Katie's
 * Pre-Sale / Post-Sale two-lane model).
 *
 * Two labeled rows:
 *   PRE-SALE   Qualifying → Estimating → Proposal → Closed (Won/Lost)
 *   POST-SALE  Pre-Construction → In Progress → Billing → Closed
 * (Post-Sale row appears once the deal is in the delivery lane.)
 *
 * Sub-status shown as a chip next to the ACTIVE pill so
 * "Qualifying · RFP" reads as one glance.
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
  qualifying: "Qualifying",
  estimating: "Estimating",
  proposal: "Proposal",
  pre_sale_closed: "Closed",
};

const POST_SALE_SHORT: Record<string, string> = {
  pre_construction: "Pre-Construction",
  in_progress: "In Progress",
  billing: "Billing",
  post_sale_closed: "Closed",
};

function pillClass(state: "complete" | "current" | "future" | "lost-cap" | "won-cap") {
  switch (state) {
    case "complete":
      return "bg-cc-brand-100 text-cc-brand-800 border-cc-brand-200";
    case "current":
      return "bg-amber-100 text-amber-900 border-amber-300 ring-2 ring-amber-300/50 shadow-sm";
    case "future":
      return "bg-white text-ppp-charcoal-400 border-ppp-charcoal-200";
    case "lost-cap":
      return "bg-rose-500 text-white border-rose-500";
    case "won-cap":
      return "bg-emerald-500 text-white border-emerald-500";
  }
}

function LaneRow({
  laneLabel,
  laneTone,
  stages,
  labels,
  currentIdx,
  activeSubStatus,
  finalCap,
}: {
  laneLabel: string;
  laneTone: "pre" | "post";
  stages: readonly OpportunityStatus[];
  labels: Record<string, string>;
  currentIdx: number;
  activeSubStatus: string | null | undefined;
  finalCap: "won" | "lost" | null;
}) {
  const laneChipCls =
    laneTone === "pre"
      ? "bg-cc-brand-50 text-cc-brand-800 border-cc-brand-200"
      : "bg-emerald-50 text-emerald-800 border-emerald-200";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className={`inline-flex items-center h-6 px-2 rounded-md border text-[10px] font-bold uppercase tracking-widest ${laneChipCls}`}
      >
        {laneLabel}
      </span>
      <div className="flex flex-wrap items-center gap-1 text-[11px] font-semibold">
        {stages.map((s, i) => {
          const isFinalPill = i === stages.length - 1;
          let state: "complete" | "current" | "future" | "lost-cap" | "won-cap";
          if (finalCap === "lost" && isFinalPill) state = "lost-cap";
          else if (finalCap === "won" && isFinalPill) state = "won-cap";
          else if (i < currentIdx) state = "complete";
          else if (i === currentIdx) state = "current";
          else state = "future";
          return (
            <span
              key={s}
              className={`px-2 py-0.5 rounded-md border ${pillClass(state)}`}
              aria-current={i === currentIdx ? "step" : undefined}
            >
              {labels[s] ?? s}
            </span>
          );
        })}
        {activeSubStatus && (
          <span className="inline-flex items-center h-5 px-1.5 rounded bg-ppp-charcoal-100 border border-ppp-charcoal-200 text-[10px] font-semibold text-ppp-charcoal-700">
            {opportunitySubStatusLabel(activeSubStatus)}
          </span>
        )}
      </div>
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

  const oppTuple = { status, sub_status };
  const won = isWon(oppTuple);
  const lostBid = isLost(oppTuple);
  const inPostSale = lane === "post_sale";

  // Karan 2026-07-13: when a deal is DECIDED at Pre-Sale (Won or Lost),
  // collapse the journey to a single terminal pill — showing the full
  // Pre-Sale row with a "Won" cap after it was noisy.
  if (won || lostBid) {
    const cap = won
      ? { bg: "bg-emerald-500", label: "Won" }
      : { bg: "bg-rose-500", label: "Lost" };
    return (
      <div className={`inline-flex items-center gap-2 ${className}`}>
        <span className="inline-flex items-center h-6 px-2 rounded-md border text-[10px] font-bold uppercase tracking-widest bg-cc-brand-50 text-cc-brand-800 border-cc-brand-200">
          Pre-Sale
        </span>
        <span
          className={`inline-flex items-center h-7 px-3 rounded-md text-[12px] font-bold text-white border ${cap.bg} border-transparent shadow-sm`}
        >
          {cap.label}
        </span>
      </div>
    );
  }

  // Pre-Sale row: always shown. Current index is the actual pre-sale
  // position OR the final "Closed" pill if the deal moved into Post-Sale
  // (i.e. Pre-Sale is fully complete).
  const preSaleActiveIdx =
    lane === "pre_sale" ? preIdx : PRE_SALE_STATUSES.length - 1;
  // Show sub-status chip in Pre-Sale row.
  const showPreSubStatus = lane === "pre_sale" && !!sub_status;

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <LaneRow
        laneLabel="Pre-Sale"
        laneTone="pre"
        stages={PRE_SALE_STATUSES}
        labels={PRE_SALE_SHORT}
        currentIdx={preSaleActiveIdx}
        activeSubStatus={showPreSubStatus ? sub_status : null}
        finalCap={null}
      />
      {inPostSale && (
        <LaneRow
          laneLabel="Post-Sale"
          laneTone="post"
          stages={POST_SALE_STATUSES}
          labels={POST_SALE_SHORT}
          currentIdx={postIdx}
          activeSubStatus={sub_status ?? null}
          finalCap={null}
        />
      )}
    </div>
  );
}
