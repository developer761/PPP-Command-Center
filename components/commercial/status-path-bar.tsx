import Link from "next/link";
import {
  isWon,
  isLost,
} from "@/lib/commercial/opportunities/constants";
import {
  PRE_CONTRACT_COLUMNS,
  POST_CONTRACT_COLUMNS,
  columnKeyForOpp,
  skippedStages,
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
type StageState = "passed" | "current" | "future" | "skipped";

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
    case "current":
      return "bg-ppp-navy text-white";
    case "passed":
      return "bg-cc-brand-600 text-white";
    // A deal dragged forward never passed through these. Showing them as
    // complete would claim work that didn't happen; showing them as future is
    // wrong too, because the deal is already past them.
    case "skipped":
      return "bg-cc-brand-100 text-cc-brand-700";
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
    >
      {state === "passed" && (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
          <path d="M20 6 9 17l-5-5" />
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
  /** Terminal outcomes rendered side by side at the tail. */
  outcomes,
  cta,
}: {
  title: string;
  stages: PathStage[];
  currentKey: string | null;
  currentSub?: string | null;
  skipped?: string[];
  notStarted?: boolean;
  outcomes?: { key: string; label: string; reached: boolean }[];
  cta?: { label: string; href: string } | null;
}) {
  const idx = stages.findIndex((s) => s.key === currentKey);
  // `null` means "not on this ladder". For the SALES path that means the deal
  // is past it (won/lost/in delivery), so everything is behind. For the
  // DELIVERY path it means the job hasn't started, so everything is ahead —
  // opposite ends, same absent key, which is why `notStarted` says which.
  const currentIdx = currentKey === null ? (notStarted ? -1 : stages.length) : idx;
  const stateFor = (i: number): StageState => {
    if (i > currentIdx) return "future";
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
                <span className={`h-2 w-2 rounded-full shrink-0 ${st === "current" ? "bg-ppp-navy" : st === "passed" ? "bg-cc-brand-600" : "bg-ppp-charcoal-200"}`} />
                <span className={st === "current" ? "font-bold text-ppp-charcoal" : st === "passed" ? "text-ppp-charcoal-600" : "text-ppp-charcoal-400"}>
                  {s.label}
                </span>
              </li>
            );
          })}
          {shown.map((o) => (
            <li key={o.key} className="flex items-center gap-2 text-[12px] px-3 py-1.5">
              <span className="h-2 w-2 rounded-full shrink-0 bg-ppp-navy" />
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
            state="current"
            first={false}
            last
          />
        ))}
        {cta && (
          <Link
            href={cta.href}
            className="ml-1.5 shrink-0 inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-cc-brand-600 text-white text-[11.5px] font-bold hover:bg-cc-brand-700 transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M20 6 9 17l-5-5" />
            </svg>
            {cta.label}
          </Link>
        )}
      </div>
      {cta && (
        <Link
          href={cta.href}
          className="sm:hidden mt-1.5 flex items-center justify-center gap-1.5 h-11 rounded-lg bg-cc-brand-600 text-white text-[12.5px] font-bold min-h-[44px]"
        >
          {cta.label}
        </Link>
      )}
    </div>
  );
}

export function StatusPathBar({
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
}: {
  status: string;
  subStatus: string | null;
  oppId: string;
  hasWinDate?: boolean;
  statusLog?: readonly { from_status?: string | null; to_status: string }[];
  manualNext?: { label: string; href: string } | null;
}) {
  const won = isWon({ status, sub_status: subStatus });
  const lost = isLost({ status, sub_status: subStatus });
  const decided = won || lost;
  const inDelivery = ["pre_construction", "in_progress", "billing", "post_sale_closed"].includes(status);

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
        stages={SALES_STAGES}
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
          currentKey={inDelivery ? status : null}
          notStarted={!inDelivery}
          currentSub={inDelivery ? subStatus : null}
          cta={inDelivery ? null : manualNext ?? null}
        />
      )}
    </div>
  );
}
