/**
 * Horizontal stage-progress strip for a deal — v2 (2026-07-13 Katie's
 * Pre-Sale / Post-Sale two-lane model).
 *
 * Karan 2026-07-15 redesign: swapped the loose row of pills for a
 * proper connected stepper. Each stage is a rounded pill separated by
 * a thin horizontal line (colored for completed stages, dashed for
 * future); the active stage is emerald + bold with the sub-status
 * rendered UNDERNEATH the active pill instead of trailing as a
 * separate chip. Lane name is a small charcoal overline above the
 * stepper (was a boxy chip inline). Much less visual noise.
 *
 *   Pre-Sale                                         (overline)
 *   ● Qualifying ── Estimating ── ● Proposal ── ─ Closed
 *                                 └ Follow Up
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

type StageState = "complete" | "current" | "future";

function stagePillCls(state: StageState, laneTone: "pre" | "post"): string {
  if (state === "current") {
    return laneTone === "pre"
      ? "bg-emerald-500 text-white border-emerald-500 shadow-sm"
      : "bg-cyan-600 text-white border-cyan-600 shadow-sm";
  }
  if (state === "complete") {
    return "bg-ppp-charcoal-100 text-ppp-charcoal-700 border-ppp-charcoal-200";
  }
  return "bg-white text-ppp-charcoal-400 border-ppp-charcoal-200";
}

function connectorCls(state: StageState): string {
  // The connector to the RIGHT of a pill takes the "downstream" tone.
  // Completed connectors are filled charcoal; current/future dashed
  // muted so the eye rests on where the deal IS.
  if (state === "complete") return "bg-ppp-charcoal-300";
  return "bg-ppp-charcoal-200 opacity-60";
}

function LaneRow({
  laneLabel,
  laneTone,
  stages,
  labels,
  currentIdx,
  activeSubStatus,
}: {
  laneLabel: string;
  laneTone: "pre" | "post";
  stages: readonly OpportunityStatus[];
  labels: Record<string, string>;
  currentIdx: number;
  activeSubStatus: string | null | undefined;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-bold uppercase tracking-widest text-ppp-charcoal-500 mb-1.5">
        {laneLabel}
      </div>
      <div className="flex items-center gap-0 flex-wrap">
        {stages.map((s, i) => {
          let state: StageState;
          if (i < currentIdx) state = "complete";
          else if (i === currentIdx) state = "current";
          else state = "future";
          const isLast = i === stages.length - 1;
          const isActive = state === "current";
          return (
            <div key={s} className="flex items-center">
              <div className="flex flex-col items-start">
                <span
                  className={`inline-flex items-center h-6 px-2.5 rounded-full border text-[11px] font-semibold ${stagePillCls(
                    state,
                    laneTone
                  )}`}
                  aria-current={isActive ? "step" : undefined}
                >
                  {labels[s] ?? s}
                </span>
                {/* Sub-status appears UNDER the active pill so it's
                    visually attached to the right stage — much clearer
                    than an appended chip that looked orphaned. */}
                {isActive && activeSubStatus && (
                  <span className="text-[10px] text-ppp-charcoal-500 mt-0.5 pl-1 truncate max-w-[140px]">
                    {opportunitySubStatusLabel(activeSubStatus)}
                  </span>
                )}
              </div>
              {!isLast && (
                <span
                  className={`h-px w-4 sm:w-6 mx-1 ${connectorCls(state)}`}
                  aria-hidden
                />
              )}
            </div>
          );
        })}
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
  // collapse the journey to a single terminal pill.
  if (won || lostBid) {
    const cap = won
      ? "bg-emerald-500 text-white border-emerald-500"
      : "bg-rose-500 text-white border-rose-500";
    const label = won ? "Won" : "Lost";
    return (
      <div className={`inline-flex flex-col gap-1 ${className}`}>
        <span className="text-[10px] font-bold uppercase tracking-widest text-ppp-charcoal-500">
          Pre-Sale
        </span>
        <span
          className={`inline-flex items-center h-7 px-3 rounded-full text-[12px] font-bold border shadow-sm w-fit ${cap}`}
        >
          {label}
        </span>
      </div>
    );
  }

  const preSaleActiveIdx =
    lane === "pre_sale" ? preIdx : PRE_SALE_STATUSES.length - 1;
  const showPreSubStatus = lane === "pre_sale" && !!sub_status;

  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      <LaneRow
        laneLabel="Pre-Sale"
        laneTone="pre"
        stages={PRE_SALE_STATUSES}
        labels={PRE_SALE_SHORT}
        currentIdx={preSaleActiveIdx}
        activeSubStatus={showPreSubStatus ? sub_status : null}
      />
      {inPostSale && (
        <LaneRow
          laneLabel="Post-Sale"
          laneTone="post"
          stages={POST_SALE_STATUSES}
          labels={POST_SALE_SHORT}
          currentIdx={postIdx}
          activeSubStatus={sub_status ?? null}
        />
      )}
    </div>
  );
}
