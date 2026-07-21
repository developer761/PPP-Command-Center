import { absoluteDate } from "@/lib/commercial/dates";
import {
  formatDurationDays,
  type OpportunityLifecycleDates,
} from "@/lib/commercial/opportunities/lifecycle";

/**
 * Bid Lifecycle Timeline — Katie 2026-07-20's flagship "how fast are we
 * moving?" view. Renders the canonical dates (RFP Received → Proposal
 * Submitted → Close) as a stepper with the two derived durations on the
 * connectors, plus the proposal Due date as an on-time / late marker.
 *
 * WHY THIS COMPONENT EXISTS: the same data used to live only on the
 * orphaned /opportunities/[id] detail page, which redirects live deals to
 * the account drill-in — so it was unreachable in the normal workflow
 * (2026-07-21 audit). Rendered at the top of the deal edit sheet.
 *
 * Server component — pure presentational, no client JS.
 */

type CloseOutcome = "won" | "lost" | null;

function DurationPill({ days }: { days: number | null }) {
  // Neutral navy accent — the point is the elapsed time, not a judgment.
  // The Due-date on-time/late marker carries the only value judgment.
  const label = formatDurationDays(days);
  const known = days !== null && days !== undefined;
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-semibold tabular-nums ${
        known
          ? "bg-ppp-navy-50 text-ppp-navy-700 border border-ppp-navy-100"
          : "bg-ppp-charcoal-50 text-ppp-charcoal-400 border border-ppp-charcoal-100"
      }`}
    >
      {label}
    </span>
  );
}

function Node({
  label,
  date,
  state,
  sub,
}: {
  label: string;
  date: string | null;
  /** filled = has happened; pending = not yet; won/lost = terminal close */
  state: "filled" | "pending" | "won" | "lost";
  sub?: React.ReactNode;
}) {
  // emerald=won/done, rose=lost, cc-brand=reached, charcoal=pending. Uses
  // emerald (NOT brand lime-green) so "won" matches the platform-wide
  // won/done semantic everywhere else (dashboard, proposal stats).
  const dot =
    state === "won"
      ? "bg-emerald-500 border-emerald-500"
      : state === "lost"
      ? "bg-rose-500 border-rose-500"
      : state === "filled"
      ? "bg-cc-brand-600 border-cc-brand-600"
      : "bg-white border-ppp-charcoal-300";
  const dateTone =
    state === "won"
      ? "text-emerald-700"
      : state === "lost"
      ? "text-rose-700"
      : state === "filled"
      ? "text-ppp-charcoal-800"
      : "text-ppp-charcoal-400";
  return (
    <div className="flex flex-row items-center gap-2.5 sm:flex-col sm:items-center sm:gap-1.5 sm:text-center">
      <span
        aria-hidden
        className={`h-3 w-3 shrink-0 rounded-full border-2 ${dot}`}
      />
      <div className="min-w-0">
        <div className="text-[10px] font-bold uppercase tracking-wide text-ppp-charcoal-500 leading-tight">
          {label}
        </div>
        <div className={`text-[12.5px] font-semibold tabular-nums leading-tight ${dateTone}`}>
          {date ? absoluteDate(date) : "—"}
        </div>
        {sub}
      </div>
    </div>
  );
}

/** Connector between two nodes: a duration pill, plus (desktop only) a
 *  hairline that runs THROUGH the dot centers. `sm:pt-[5px]` lifts the
 *  line to ~the 12px dot's vertical center (6px) so it bisects the dots
 *  instead of floating below them. */
function Connector({ days }: { days: number | null }) {
  return (
    <div className="flex items-center gap-2 pl-[5px] sm:flex-1 sm:flex-col sm:gap-1 sm:pl-0 sm:pt-[5px]">
      <span aria-hidden className="hidden h-px w-full bg-ppp-charcoal-200 sm:block" />
      <DurationPill days={days} />
    </div>
  );
}

export function BidLifecycleTimeline({
  lifecycle,
  closeOutcome = null,
  className = "",
}: {
  lifecycle: OpportunityLifecycleDates;
  /** Drives the Close node color/label. null → still open. */
  closeOutcome?: CloseOutcome;
  className?: string;
}) {
  const {
    rfp_received_at,
    proposal_submitted_at,
    proposal_due_at,
    decided_at,
    time_to_proposal_days,
    time_to_sale_days,
  } = lifecycle;

  // Don't render an all-dashes card. The timeline is only meaningful once
  // at least one milestone has happened (RFP in / proposal out / closed).
  // A lone Due date isn't enough — it still shows in the form's Timeline
  // section below. (2026-07-21 audit: the all-null card was the common
  // case on new/early deals and read as broken.)
  const hasMilestone = Boolean(
    rfp_received_at || proposal_submitted_at || decided_at
  );
  if (!hasMilestone) return null;

  // Due-date on-time / late judgment (the only value-colored element).
  let dueMarker: React.ReactNode = null;
  if (proposal_due_at) {
    const due = new Date(proposal_due_at).getTime();
    let tone = "text-ppp-charcoal-500";
    let note = "";
    if (proposal_submitted_at) {
      const sent = new Date(proposal_submitted_at).getTime();
      if (Number.isFinite(due) && Number.isFinite(sent)) {
        if (sent <= due) {
          tone = "text-emerald-700";
          note = " · on time";
        } else {
          tone = "text-amber-700";
          note = " · late";
        }
      }
    } else if (Number.isFinite(due) && due < Date.now() && !decided_at) {
      // Only "overdue" while still open — a decided deal that never sent a
      // formal proposal shouldn't read as overdue (re-audit, minor).
      tone = "text-rose-700";
      note = " · overdue";
    }
    dueMarker = (
      <div className={`mt-0.5 text-[10.5px] font-medium ${tone}`}>
        Due {absoluteDate(proposal_due_at)}
        {note}
      </div>
    );
  }

  const closeState: "filled" | "pending" | "won" | "lost" = decided_at
    ? closeOutcome === "won"
      ? "won"
      : closeOutcome === "lost"
      ? "lost"
      : "filled"
    : "pending";
  const closeLabel =
    closeOutcome === "won" ? "Won" : closeOutcome === "lost" ? "Lost" : "Close";

  return (
    <div
      className={`rounded-xl border border-ppp-charcoal-100 bg-white p-4 ${className}`}
    >
      <div className="mb-3 flex items-center gap-2">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-ppp-navy-600"
          aria-hidden
        >
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
        <h3 className="text-[11px] font-bold uppercase tracking-widest text-ppp-navy-700">
          Bid lifecycle
        </h3>
      </div>

      {/* Desktop: horizontal stepper with the connector line bisecting the
          dots. Mobile: vertical stack with pills between rows. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-1">
        <Node
          label="RFP received"
          date={rfp_received_at}
          state={rfp_received_at ? "filled" : "pending"}
        />
        <Connector days={time_to_proposal_days} />
        <Node
          label="Proposal submitted"
          date={proposal_submitted_at}
          state={proposal_submitted_at ? "filled" : "pending"}
          sub={dueMarker}
        />
        <Connector days={time_to_sale_days} />
        <Node label={closeLabel} date={decided_at} state={closeState} />
      </div>
    </div>
  );
}
