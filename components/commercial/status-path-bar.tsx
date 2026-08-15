import Link from "next/link";
import { NextStepButton } from "@/components/commercial/next-step-button";
import type { NextStep } from "@/lib/commercial/opportunities/attention";
import {
  isWon,
  isLost,
  POST_SALE_STATUSES,
} from "@/lib/commercial/opportunities/constants";
import {
  PRE_CONTRACT_COLUMNS,
  POST_CONTRACT_COLUMNS,
  columnKeyForOpp,
  skippedStages,
  STAGE_MEANING,
} from "@/lib/commercial/opportunities/kanban-columns";

/**
 * The status path — the Salesforce-style chevron bar across the top of a job.
 *
 * Karan 2026-08-12, from the Quote screenshot: chevrons pointing forward,
 * passed stages filled with a check, the current one filled navy, future ones
 * grey, and the two terminal outcomes side by side at the tail.
 *
 * TWO bars, not one. The sale and the work have different ladders and different
 * owners, and a single eleven-stop path is unreadable. The sales path renders on
 * every deal; the delivery path appears once the job is won.
 *
 * Where this deliberately differs from Salesforce: the CTA at the right end is
 * a **manual override**, not the primary way to move. Status advances on its own
 * from artifacts (the auto-advance engine, 2026-08-11), so a button that always
 * says "mark this complete" would give a person a second way to fight the
 * engine over the same transition. It appears only when nothing can imply the
 * next step.
 *
 * Server component — no client JS. Mobile collapse uses <details>, so it works
 * with JS disabled and costs no hydration.
 */

export type PathStage = {
  key: string;
  label: string;
  /** Rendered under the current chevron — the sub-status, e.g. "Follow Up". */
  sub?: string | null;
};

// `dropped` was never produced and is gone. `skipped` WAS never produced
// either — stateFor only ever returned passed/current/future — so a deal that
// jumped stages showed every stage behind it as completed, ticks and all,
// claiming work that never happened. It is wired now.
// Same checkpoint grammar as the delivery spine on the Project tab, so the two
// status bars read as one system (Karan 2026-08-15): GREEN ✓ = passed/done,
// AMBER = the stage in progress right now, GREY = future, plus the two edge
// cases the spine doesn't have — SKIPPED (jumped, never entered) and the WON /
// LOST outcome tails.
type StageState = "passed" | "current" | "future" | "skipped" | "won" | "lost";

/**
 * Sales ladder — Brendan's stages, with Qualifying kept at the front.
 *
 * This is the SAME list the pipeline, the saved views, the export and the
 * reports use (`PRE_CONTRACT_COLUMNS`), rather than a second copy keyed on the
 * top-level status. That divergence is what Karan hit: the bar tracked
 * `status` while everyone thinks in the stage, so setting a deal to Pending
 * Approval — a sub-status move — changed nothing on screen.
 *
 * The tail branches: a deal ends Won **or** Lost, never both.
 */
const SALES_STAGES: PathStage[] = PRE_CONTRACT_COLUMNS
  .filter((c) => c.key !== "won" && c.key !== "lost")
  .map((c) => ({ key: c.key, label: c.label }));
/**
 * Delivery ladder — the project's own path, shown once the job is won.
 *
 * AUDIT 2026-08-12: this was hardcoded, and had already drifted — it called the
 * last stage "Closed Out" while the pipeline, the filters and the reports all
 * called it "Completed". Two words for one stage, on two screens somebody looks
 * at in the same minute. Derived from the shared columns now, like the sales
 * ladder above it.
 */
const DELIVERY_STAGES: PathStage[] = POST_CONTRACT_COLUMNS.map((c) => ({
  key: c.key,
  label: c.label,
}));

function chevronCls(state: StageState): string {
  switch (state) {
    case "passed":
      return "bg-emerald-500 text-white"; // done — green ✓, matching the spine
    case "won":
      return "bg-emerald-600 text-white"; // the win, done
    case "current":
      // In progress right now. Amber carries a text label here, so it takes dark
      // text (white on amber is unreadable) — a standard in-progress treatment.
      return "bg-amber-400 text-amber-950";
    case "lost":
      return "bg-rose-500 text-white";
    // A deal dragged forward never passed through these. Showing them as
    // complete would claim work that didn't happen; showing them as future is
    // wrong too, because the deal is already past them.
    case "skipped":
      return "bg-amber-100 text-amber-700";
    default:
      return "bg-ppp-charcoal-100 text-ppp-charcoal-500";
  }
}

function Chevron({
  stage,
  state,
  first,
  last,
}: {
  stage: PathStage;
  state: StageState;
  first: boolean;
  last: boolean;
}) {
  // The arrow shape. A notch on the right of every chevron and a matching notch
  // on the left of every one except the first, so they interlock.
  const clip = last
    ? first
      ? "none"
      : "polygon(0 0, calc(100% - 12px) 0, 100% 50%, calc(100% - 12px) 100%, 0 100%, 12px 50%)"
    : first
      ? "polygon(0 0, calc(100% - 12px) 0, 100% 50%, calc(100% - 12px) 100%, 0 100%)"
      : "polygon(0 0, calc(100% - 12px) 0, 100% 50%, calc(100% - 12px) 100%, 0 100%, 12px 50%)";
  return (
    <div
      className={`relative flex-1 min-w-[104px] h-9 flex items-center justify-center gap-1.5 px-3 ${chevronCls(state)}`}
      style={{ clipPath: clip }}
      aria-current={state === "current" ? "step" : undefined}
      // What this stage MEANS, so the definition sits where the decision to
      // move a deal is actually made. Karan 2026-08-13: "write what is
      // considered as pre-construction, in progress etc, so we know when the
      // status bar should update."
      title={STAGE_MEANING[stage.key]}
    >
      {(state === "passed" || state === "won") && (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )}
      {state === "lost" && (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      )}
      <span className="text-[11.5px] font-bold leading-none truncate">{stage.label}</span>
      {state === "skipped" && (
        <span className="text-[9px] font-bold uppercase tracking-wide opacity-70">skipped</span>
      )}
    </div>
  );
}

function PathRow({
  title,
  stages,
  currentKey,
  currentSub,
  /** Stages behind the current one that were never actually entered. */
  skipped,
  /** With no current stage: is the ladder entirely AHEAD (a won job that has
   *  not started) rather than entirely behind (a closed sale)? */
  notStarted,
  /** Stages with real ACTIVITY that sit AHEAD of the current one — e.g. billing
   *  started while the deal is still officially Pre-Construction. They render
   *  amber (in-progress) instead of grey, so the chevron matches the Project
   *  spine, which shows early activity (Karan 2026-08-15). */
  activeKeys,
  /** Terminal outcomes rendered side by side at the tail. */
  outcomes,
  cta,
  oppId,
}: {
  title: string;
  stages: PathStage[];
  currentKey: string | null;
  currentSub?: string | null;
  skipped?: string[];
  notStarted?: boolean;
  activeKeys?: string[];
  outcomes?: { key: string; label: string; reached: boolean }[];
  /** The next-step. Rendered by NextStepButton so a one-destination move
   *  posts on click instead of opening a form — see that component. */
  cta?: NextStep | null;
  oppId?: string;
}) {
  const idx = stages.findIndex((s) => s.key === currentKey);
  // `null` means "not on this ladder". For the SALES path that means the deal
  // is past it (won/lost/in delivery), so everything is behind. For the
  // DELIVERY path it means the job hasn't started, so everything is ahead —
  // opposite ends, same absent key, which is why `notStarted` says which.
  const currentIdx = currentKey === null ? (notStarted ? -1 : stages.length) : idx;
  const stateFor = (i: number): StageState => {
    if (i > currentIdx) {
      // A stage ahead of the official one but already worked (billing started
      // early) reads as in-progress, not "not reached" — matches the spine.
      return activeKeys?.includes(stages[i]?.key ?? "") ? "current" : "future";
    }
    if (i === currentIdx) return "current";
    // Behind the current stage — but did it actually go through here? A deal
    // dragged from Proposal straight into delivery never passed Closed Won, and
    // ticking it says the sale was recorded when it wasn't.
    return skipped?.includes(stages[i]?.key ?? "") ? "skipped" : "passed";
  };

  const shown = outcomes?.filter((o) => o.reached) ?? [];
  const anyOutcomeReached = shown.length > 0;
  // Position for the "Stage N of M" mobile summary.
  const total = stages.length + (outcomes ? 1 : 0);
  const position = anyOutcomeReached ? total : Math.min(currentIdx + 1, total);
  const currentLabel = anyOutcomeReached
    ? shown[0].label
    : (stages[currentIdx]?.label ?? stages[stages.length - 1]?.label ?? "—");

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] font-bold uppercase tracking-widest text-ppp-charcoal-500">
          {title}
        </span>
        {currentSub && (
          <span className="text-[10.5px] text-ppp-charcoal-500 truncate">
            · {currentSub}
          </span>
        )}
      </div>

      {/* ── Phone: six chevrons do not fit, and a status bar you scroll
             sideways is worse than no status bar. Collapse to a summary that
             expands on tap. <details> so it needs no JS. ── */}
      <details className="sm:hidden group">
        <summary className="list-none flex items-center justify-between gap-2 h-11 px-3 rounded-lg bg-ppp-charcoal-50 border border-ppp-charcoal-200 cursor-pointer min-h-[44px]">
          <span className="text-[12px] font-bold text-ppp-charcoal truncate">
            <span className="text-ppp-charcoal-500 font-semibold">
              Stage {position} of {total} ·{" "}
            </span>
            {currentLabel}
          </span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-ppp-charcoal-500 group-open:rotate-180 transition-transform">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </summary>
        <ol className="mt-1.5 space-y-1">
          {stages.map((s, i) => {
            const st = stateFor(i);
            return (
              <li key={s.key} className="flex items-center gap-2 text-[12px] px-3 py-1.5">
                <span className={`h-2 w-2 rounded-full shrink-0 ${st === "current" ? "bg-amber-400" : st === "passed" ? "bg-emerald-500" : st === "skipped" ? "bg-amber-200" : "bg-ppp-charcoal-200"}`} />
                <span className={st === "current" ? "font-bold text-ppp-charcoal" : st === "passed" ? "text-ppp-charcoal-600" : "text-ppp-charcoal-400"}>
                  {s.label}
                  {st === "skipped" && <span className="ml-1.5 text-[9.5px] font-bold uppercase tracking-wide text-amber-600">skipped</span>}
                </span>
              </li>
            );
          })}
          {shown.map((o) => (
            <li key={o.key} className="flex items-center gap-2 text-[12px] px-3 py-1.5">
              <span className={`h-2 w-2 rounded-full shrink-0 ${o.key === "won" ? "bg-emerald-500" : "bg-rose-500"}`} />
              <span className="font-bold text-ppp-charcoal">{o.label}</span>
            </li>
          ))}
        </ol>
      </details>

      {/* ── Desktop: the chevron path. ── */}
      <div className="hidden sm:flex items-stretch gap-0.5">
        {stages.map((s, i) => (
          <Chevron
            key={s.key}
            stage={s}
            state={stateFor(i)}
            first={i === 0}
            last={false}
          />
        ))}
        {/* Only the outcome that HAPPENED renders. Two greyed outcomes side by
            side reads as "not decided yet", which is the opposite of true on a
            closed deal. */}
        {shown.map((o) => (
          <Chevron
            key={o.key}
            stage={{ key: o.key, label: o.label }}
            state={o.key === "won" ? "won" : "lost"}
            first={false}
            last
          />
        ))}
        {cta && (
          <NextStepButton step={cta} oppId={oppId} size="lg" className="ml-1.5 shrink-0" />
        )}
      </div>
      {/* The desktop copy above sits inline with the chevrons; on a phone it
          gets its own full-width row. Same component, so a one-destination
          move posts on click in both. */}
      {cta && (
        <div className="sm:hidden mt-1.5">
          <NextStepButton step={cta} oppId={oppId} size="lg" className="w-full justify-center" />
        </div>
      )}
    </div>
  );
}

export function StatusPathBar({
  proposalApproved = false,
  status,
  subStatus,
  oppId,
  /** Was a decision date ever recorded? A job dragged into delivery on a verbal
   *  yes has none, and never passed through Closed Won. */
  hasWinDate,
  /** The deal's status history. Only evidence of a status it NEVER held can
   *  mark a stage skipped — see `skippedStages`. Empty (or absent, for a deal
   *  predating logging) means no stage is accused. */
  statusLog = [],
  /** The next step a person can take when no artifact implies it. */
  manualNext,
  /** Has any billing happened (invoice or AIA)? If so the Billing delivery stage
   *  shows amber even while the deal is officially at an earlier stage, so the
   *  chevron agrees with the Project spine (Karan 2026-08-15). */
  billingStarted = false,
}: {
  /** The deal's current proposal has been approved but not yet sent.
   *
   *  The deal legitimately stays at Estimating / proposal_pending_approval —
   *  approving is not sending — but that step is LABELLED "Pending Approval",
   *  so after Brendan approved, the bar went on saying the opposite of what
   *  had just happened. The stage is right; the word was wrong. */
  proposalApproved?: boolean;
  status: string;
  subStatus: string | null;
  oppId: string;
  hasWinDate?: boolean;
  statusLog?: readonly { from_status?: string | null; to_status: string }[];
  manualNext?: NextStep | null;
  billingStarted?: boolean;
}) {
  const won = isWon({ status, sub_status: subStatus });
  const lost = isLost({ status, sub_status: subStatus });
  const decided = won || lost;
  const inDelivery = (POST_SALE_STATUSES as readonly string[]).includes(status);

  // Where the SALES path sits. A deal in delivery is past the whole sales
  // ladder, so it shows as fully passed with Closed Won at the tail — the sale
  // did happen, it just wasn't recorded as a formal close.
  // Position by STAGE. `columnKeyForOpp` is the one mapper the whole platform
  // uses to turn a (status, sub_status) tuple into a stage, so the bar can no
  // longer disagree with the list, the filters or the reports.
  const salesCurrent = decided || inDelivery ? null : columnKeyForOpp(status, subStatus);

  return (
    <div className="space-y-3">
      <PathRow
        title="Sale"
        stages={
          // Same stage, honest word. Once the proposal is approved the deal is
          // waiting to be SENT, not waiting to be approved.
          proposalApproved
            ? SALES_STAGES.map((st) =>
                st.key === "pending_approval" ? { ...st, label: "Approved — ready to send" } : st
              )
            : SALES_STAGES
        }
        currentKey={salesCurrent}
        // The stage IS the sub-status now, so repeating it beside the title
        // would print the same word twice.
        currentSub={null}
        outcomes={[
          // Reached only if it genuinely was — see `skipped` above.
          { key: "won", label: "Closed Won", reached: won || (inDelivery && (decided || !!hasWinDate)) },
          { key: "lost", label: "Closed Lost", reached: lost },
        ]}
        // Two ways a stage gets marked rather than ticked.
        //
        // The general one: the status log proves the deal never held the
        // status behind that stage — a bid dragged from RFP straight to Sent
        // was never `estimating`, so Estimating and Pending Approval are
        // jumped, not done.
        //
        // The specific one: a job in delivery that was never recorded as won
        // never passed Closed Won. Ticking it would claim a sale nobody
        // logged, and the win date is what "wins this month" counts.
        skipped={[
          ...skippedStages(
            SALES_STAGES.map((st) => st.key),
            statusLog
          ),
          ...(inDelivery && !decided && !hasWinDate ? ["won"] : []),
        ]}
        cta={decided || inDelivery ? null : manualNext ?? null}
        oppId={oppId}
      />
      {(won || inDelivery) && (
        <PathRow
          title="Delivery"
          stages={DELIVERY_STAGES}
          skipped={skippedStages(DELIVERY_STAGES.map((st) => st.key), statusLog)}
          // AUDIT: the comment said "nothing is current yet" and then passed
          // "pre_construction" anyway, so a job won this morning showed
          // Pre-Construction as underway before anyone had touched it. Null
          // means nothing is highlighted — the whole path reads as ahead of
          // you, which is what "won, not started" actually means.
          // A COMPLETED job (post_sale_closed) is DONE — every delivery stage is
          // passed/green, not "Completed" sitting amber as if in progress. Only a
          // still-running delivery status is the amber current stage (audit
          // 2026-08-15). currentKey null + notStarted false → all passed.
          currentKey={inDelivery && status !== "post_sale_closed" ? status : null}
          // Billing amber when money's moved, even if the deal is officially at
          // an earlier delivery stage — matches the Project spine.
          activeKeys={billingStarted ? ["billing"] : []}
          notStarted={!inDelivery}
          currentSub={inDelivery ? subStatus : null}
          cta={inDelivery ? null : manualNext ?? null}
          oppId={oppId}
        />
      )}
    </div>
  );
}
