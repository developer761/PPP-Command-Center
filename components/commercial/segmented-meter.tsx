/**
 * SegmentedMeter — a progress bar that breaks into one segment PER MILESTONE.
 *
 * When an invoice is billed in milestones, a single bar hides the schedule. This
 * splits it into chunks sized by each milestone's amount, each with its own
 * paid-fill and a mini-header (name · due date) above it, so a 3-milestone
 * invoice reads as three labeled steps at a glance.
 *
 * Colors follow the platform rule (blue in-progress / green paid / amber
 * attention — never red). Server-renderable (no hooks). Horizontally scrolls
 * on narrow screens so labels never crush.
 */

export type MeterSegment = {
  name: string;
  /** Pre-formatted due date, or null. */
  due?: string | null;
  amountCents: number;
  paidCents: number;
  /** Past due + not fully paid → amber emphasis. */
  overdue?: boolean;
};

function fmt(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export function SegmentedMeter({
  segments,
  className = "",
}: {
  segments: MeterSegment[];
  className?: string;
}) {
  if (segments.length === 0) return null;
  return (
    <div className={`overflow-x-auto -mx-1 px-1 ${className}`}>
      <div className="flex gap-2 min-w-full">
        {segments.map((s, i) => {
          // A deduct change order rides in as a NEGATIVE milestone (a credit).
          // Size the chunk by the magnitude, and render it as a rose "Credit"
          // rather than a near-zero-width "Unpaid / waiver ×" chunk (audit F9).
          const isCredit = s.amountCents < 0;
          const pct = s.amountCents > 0 ? Math.max(0, Math.min(100, Math.round((s.paidCents / s.amountCents) * 100))) : 0;
          const fullyPaid = s.amountCents > 0 && s.paidCents >= s.amountCents;
          const partial = s.paidCents > 0 && !fullyPaid;
          const fill = isCredit ? "bg-rose-400" : fullyPaid ? "bg-emerald-500" : partial ? "bg-ppp-blue-500" : "bg-ppp-charcoal-200";
          const dueCls = s.overdue ? "text-amber-700 font-semibold" : "text-ppp-charcoal-400";
          return (
            <div key={i} className="flex flex-col min-w-[76px]" style={{ flexGrow: Math.max(1, Math.abs(s.amountCents)) }}>
              {/* Mini-header — name + due */}
              <div className="mb-1 min-w-0">
                <div className="text-[10.5px] font-semibold text-ppp-charcoal truncate" title={s.name}>{s.name}</div>
                <div className={`text-[9.5px] ${isCredit ? "text-rose-600" : dueCls} truncate`}>{isCredit ? "Change-order credit" : s.due ? `Due ${s.due}` : "No due date"}</div>
              </div>
              {/* Chunk */}
              <div className="h-2.5 rounded-full bg-ppp-charcoal-100 overflow-hidden relative" title={isCredit ? `Credit ${fmt(Math.abs(s.amountCents))}` : `${fmt(s.paidCents)} of ${fmt(s.amountCents)}`}>
                <div className={`h-full rounded-full transition-all ${fill}`} style={{ width: `${isCredit ? 100 : pct}%` }} />
              </div>
              {/* Amount + state */}
              <div className="mt-1 flex items-center justify-between gap-1 text-[9.5px]">
                <span className={`tabular-nums font-semibold ${isCredit ? "text-rose-700" : "text-ppp-charcoal-600"}`}>{isCredit ? `−${fmt(Math.abs(s.amountCents))}` : fmt(s.amountCents)}</span>
                {isCredit ? (
                  <span className="text-rose-600 font-bold uppercase tracking-wide">Credit</span>
                ) : fullyPaid ? (
                  <span className="inline-flex items-center gap-0.5 text-emerald-600 font-bold uppercase tracking-wide"><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>Paid</span>
                ) : partial ? (
                  <span className="text-ppp-blue-700 font-semibold tabular-nums">{pct}%</span>
                ) : (
                  <span className={s.overdue ? "text-amber-700 font-semibold" : "text-ppp-charcoal-400"}>Unpaid</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default SegmentedMeter;
