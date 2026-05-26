"use client";

/**
 * Work Order Progress Bar — 8-stage timeline per WO.
 *
 *   ⓪ Form Sent
 *   ① Customer Opened
 *   ② Customer Submitted
 *   ③ Supplier Order Drafted
 *   ④ Sent to Supplier
 *   ⑤ Supplier Acknowledged
 *   ⑥ Materials Delivered
 *   ⑦ Job Complete
 *
 * Color coding (per Karan's spec):
 *   green  = stage completed
 *   blue   = currently active (the "where are we" cursor)
 *   orange = stuck (stage active for too long — see STUCK_THRESHOLDS)
 *   gray   = not yet reached
 *
 * Mobile: stepper becomes a vertical timeline on <sm so the labels
 * don't squish. Each step shows a tiny relative-time stamp when reached.
 *
 * Data source: parent passes `progress` — a server-derived bundle of
 * timestamps from customer_form_tokens + supplier_orders. See
 * lib/wo-progress/derive.ts for the canonical builder. This component is
 * presentational only.
 */

export type WoProgress = {
  workOrderId: string;
  workOrderNumber: string | null;
  formSentAt: string | null;
  formOpenedAt: string | null;
  formSubmittedAt: string | null;
  /** When multiple suppliers — earliest draft across them. UI shows
   *  per-supplier sub-rows when there are >1 supplier orders. */
  supplierDraftedAt: string | null;
  supplierSentAt: string | null;
  supplierAcknowledgedAt: string | null;
  materialsDeliveredAt: string | null;
  jobCompletedAt: string | null;
  /** Per-supplier breakdown for stages 3-6 (when multi-supplier WO). */
  perSupplier?: Array<{
    supplierAccountId: string;
    supplierName: string;
    draftedAt: string | null;
    sentAt: string | null;
    acknowledgedAt: string | null;
    deliveredAt: string | null;
  }>;
};

type StageState = "done" | "active" | "stuck" | "pending";

type StageDef = {
  key: keyof Pick<
    WoProgress,
    "formSentAt" | "formOpenedAt" | "formSubmittedAt"
    | "supplierDraftedAt" | "supplierSentAt" | "supplierAcknowledgedAt"
    | "materialsDeliveredAt" | "jobCompletedAt"
  >;
  label: string;
  shortLabel: string;          // compact label for mobile
  /** When this stage has been "active" for longer than N days without
   *  advancing, render in orange to flag the bottleneck. null = never stuck. */
  stuckAfterDays: number | null;
};

const STAGES: StageDef[] = [
  { key: "formSentAt",             label: "Form Sent",          shortLabel: "Sent",        stuckAfterDays: 3 },
  { key: "formOpenedAt",           label: "Customer Opened",    shortLabel: "Opened",      stuckAfterDays: 5 },
  { key: "formSubmittedAt",        label: "Customer Submitted", shortLabel: "Submitted",   stuckAfterDays: null },
  { key: "supplierDraftedAt",      label: "Order Drafted",      shortLabel: "Drafted",     stuckAfterDays: 2 },
  { key: "supplierSentAt",         label: "Sent to Supplier",   shortLabel: "Sent",        stuckAfterDays: 1 },
  { key: "supplierAcknowledgedAt", label: "Supplier Confirmed", shortLabel: "Confirmed",   stuckAfterDays: 3 },
  { key: "materialsDeliveredAt",   label: "Materials Delivered",shortLabel: "Delivered",   stuckAfterDays: null },
  { key: "jobCompletedAt",         label: "Job Complete",       shortLabel: "Complete",    stuckAfterDays: null },
];

/** Resolve each stage's visual state from the timestamps. */
function computeStates(progress: WoProgress): StageState[] {
  const now = Date.now();
  const states: StageState[] = STAGES.map(() => "pending");
  // Walk left-to-right; the latest completed stage is "done", the next is "active".
  let lastDoneIdx = -1;
  for (let i = 0; i < STAGES.length; i++) {
    const ts = progress[STAGES[i].key];
    if (ts) {
      states[i] = "done";
      lastDoneIdx = i;
    }
  }
  // The next stage after the last-done is "active" (current cursor)
  const activeIdx = lastDoneIdx + 1;
  if (activeIdx < STAGES.length) {
    states[activeIdx] = "active";
    // If the PREVIOUS stage finished long ago without this one advancing,
    // flag this stage as "stuck" (orange). E.g., form sent 4 days ago and
    // customer hasn't opened → stage 1 (Opened) becomes stuck.
    const stage = STAGES[activeIdx];
    if (stage.stuckAfterDays !== null && lastDoneIdx >= 0) {
      const prevTs = progress[STAGES[lastDoneIdx].key];
      if (prevTs) {
        const age = (now - new Date(prevTs).getTime()) / 86_400_000;
        if (age >= stage.stuckAfterDays) {
          states[activeIdx] = "stuck";
        }
      }
    }
  }
  return states;
}

/** "5/26 2:14pm" — compact local-time format for the step labels. */
function formatStepTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const dateStr = d.toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
  const timeStr = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase().replace(" ", "");
  return `${dateStr} ${timeStr}`;
}

const STATE_CLASSES: Record<StageState, { dot: string; line: string; label: string; time: string }> = {
  done: {
    dot: "bg-ppp-green text-white border-ppp-green",
    line: "bg-ppp-green",
    label: "text-ppp-charcoal font-semibold",
    time: "text-ppp-charcoal-500",
  },
  active: {
    dot: "bg-ppp-blue text-white border-ppp-blue ring-2 ring-ppp-blue/30",
    line: "bg-ppp-charcoal-100",
    label: "text-ppp-blue-700 font-semibold",
    time: "text-ppp-blue-700",
  },
  stuck: {
    dot: "bg-ppp-orange text-white border-ppp-orange ring-2 ring-ppp-orange/30",
    line: "bg-ppp-charcoal-100",
    label: "text-ppp-orange-700 font-semibold",
    time: "text-ppp-orange-700",
  },
  pending: {
    dot: "bg-white text-ppp-charcoal-200 border-ppp-charcoal-100",
    line: "bg-ppp-charcoal-100",
    label: "text-ppp-charcoal-200 font-medium",
    time: "text-ppp-charcoal-200",
  },
};

export default function WorkOrderProgressBar({
  progress,
  variant = "full",
}: {
  progress: WoProgress;
  /** "full" = labels + timestamps below each dot (default). "compact" =
   *  dots only on a single line (used inside dense list views). */
  variant?: "full" | "compact";
}) {
  const states = computeStates(progress);

  if (variant === "compact") {
    return (
      <div className="flex items-center gap-0.5" aria-label="Work order progress">
        {STAGES.map((stage, i) => {
          const cls = STATE_CLASSES[states[i]];
          return (
            <div key={stage.key} className="flex items-center">
              <span
                className={`h-2 w-2 rounded-full border ${cls.dot}`}
                title={`${stage.label}${progress[stage.key] ? ` · ${formatStepTime(progress[stage.key])}` : ""}`}
                aria-label={`${stage.label}: ${states[i]}`}
              />
              {i < STAGES.length - 1 && (
                <span className={`h-0.5 w-3 ${states[i] === "done" ? STATE_CLASSES.done.line : STATE_CLASSES.pending.line}`} />
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="bg-white border border-ppp-charcoal-100 rounded-xl px-4 py-4 sm:px-5 sm:py-5">
      <div className="font-condensed text-[10px] uppercase tracking-wider text-ppp-charcoal-500 mb-3">
        Progress · Work Order {progress.workOrderNumber ?? progress.workOrderId.slice(-6)}
      </div>

      {/* Desktop / tablet: horizontal stepper */}
      <ol className="hidden sm:flex items-start gap-1" role="list" aria-label="Work order progress">
        {STAGES.map((stage, i) => {
          const state = states[i];
          const cls = STATE_CLASSES[state];
          const ts = progress[stage.key];
          const isLast = i === STAGES.length - 1;
          return (
            <li key={stage.key} className="flex-1 flex flex-col items-center min-w-0">
              <div className="flex items-center w-full">
                <span className="flex-1 h-[2px]" aria-hidden>
                  {i > 0 && (
                    <span
                      className={`block h-full ${states[i - 1] === "done" ? STATE_CLASSES.done.line : STATE_CLASSES.pending.line}`}
                    />
                  )}
                </span>
                <span
                  className={`h-7 w-7 rounded-full border-2 flex items-center justify-center text-[11px] font-bold shrink-0 ${cls.dot}`}
                  aria-label={`Stage ${i + 1}: ${stage.label}, status ${state}`}
                >
                  {state === "done" ? "✓" : i + 1}
                </span>
                <span className="flex-1 h-[2px]" aria-hidden>
                  {!isLast && (
                    <span
                      className={`block h-full ${state === "done" ? STATE_CLASSES.done.line : STATE_CLASSES.pending.line}`}
                    />
                  )}
                </span>
              </div>
              <div className="mt-2 text-center px-0.5 min-h-[2rem]">
                <div className={`text-[10px] leading-tight ${cls.label}`}>{stage.label}</div>
                {ts && (
                  <div className={`text-[9px] leading-tight mt-0.5 ${cls.time}`}>
                    {formatStepTime(ts)}
                  </div>
                )}
                {!ts && state === "stuck" && (
                  <div className="text-[9px] leading-tight mt-0.5 text-ppp-orange-700 font-semibold">
                    Waiting
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {/* Mobile: vertical timeline */}
      <ol className="sm:hidden space-y-2" role="list" aria-label="Work order progress">
        {STAGES.map((stage, i) => {
          const state = states[i];
          const cls = STATE_CLASSES[state];
          const ts = progress[stage.key];
          const isLast = i === STAGES.length - 1;
          return (
            <li key={stage.key} className="flex items-start gap-2.5">
              <div className="flex flex-col items-center shrink-0">
                <span
                  className={`h-6 w-6 rounded-full border-2 flex items-center justify-center text-[10px] font-bold ${cls.dot}`}
                  aria-label={`Stage ${i + 1}: ${stage.label}, status ${state}`}
                >
                  {state === "done" ? "✓" : i + 1}
                </span>
                {!isLast && (
                  <span
                    className={`w-[2px] h-5 mt-0.5 ${state === "done" ? STATE_CLASSES.done.line : STATE_CLASSES.pending.line}`}
                    aria-hidden
                  />
                )}
              </div>
              <div className="flex-1 min-w-0 pb-2">
                <div className={`text-xs leading-tight ${cls.label}`}>{stage.shortLabel}</div>
                {ts && (
                  <div className={`text-[10px] leading-tight mt-0.5 ${cls.time}`}>
                    {formatStepTime(ts)}
                  </div>
                )}
                {!ts && state === "stuck" && (
                  <div className="text-[10px] leading-tight mt-0.5 text-ppp-orange-700 font-semibold">
                    Waiting on this step
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {/* Per-supplier sub-rows when this WO has multiple suppliers in flight */}
      {progress.perSupplier && progress.perSupplier.length > 1 && (
        <div className="mt-4 pt-3 border-t border-ppp-charcoal-100">
          <div className="text-[10px] uppercase tracking-wider font-bold text-ppp-charcoal-500 mb-1.5">
            Per supplier
          </div>
          <ul className="space-y-1 text-[11px]">
            {progress.perSupplier.map((s) => (
              <li key={s.supplierAccountId} className="flex items-center justify-between gap-2">
                <span className="font-medium text-ppp-charcoal truncate">{s.supplierName}</span>
                <span className="text-ppp-charcoal-500 shrink-0">
                  {s.deliveredAt ? `Delivered ${formatStepTime(s.deliveredAt)}` :
                   s.acknowledgedAt ? `Acked ${formatStepTime(s.acknowledgedAt)}` :
                   s.sentAt ? `Sent ${formatStepTime(s.sentAt)}` :
                   s.draftedAt ? `Drafted ${formatStepTime(s.draftedAt)}` :
                   "Pending"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
