import { formatCentsFull, formatCentsCompact } from "@/lib/commercial/invoices/format";

/**
 * The money chain for one job, end to end.
 *
 * Karan 2026-08-13: *"let's have an analytics page for the KPI board with
 * everything feeding into it."*
 *
 * Deliberately NOT another company-wide report — there are four of those
 * already. The question this answers is the one you have standing on a single
 * job: where did the contract go, and how much of it have we actually got.
 *
 * It reads as a chain because that is what it is, and each step can only
 * shrink from the one above it:
 *
 *   Contract to date  (base + approved change orders)
 *     → Invoiced      (what we have asked for)
 *       → Collected   (what has arrived)
 *   less Costs        (materials, subs, crew)
 *     = Margin
 *
 * Every gap between two bars is a question worth asking. Contract vs invoiced
 * is work done and unbilled; invoiced vs collected is money owed; and the
 * retainage line names the part that is neither — earned, billed, and withheld
 * until closeout.
 */

export type DealAnalytics = {
  contractBaseCents: number;
  approvedCoCents: number;
  contractToDateCents: number;
  invoicedCents: number;
  collectedCents: number;
  openBalanceCents: number;
  retainageCents: number;
  costsCents: number;
  crewLaborCents: number;
  purchasesCents: number;
  marginCents: number;
  marginPct: number | null;
  /** Approved crew hours with no cost rate — margin is overstated by them. */
  unratedHours: number;
};

function Bar({
  label,
  value,
  of,
  tone,
  note,
}: {
  label: string;
  value: number;
  of: number;
  tone: string;
  note?: string;
}) {
  const pct = of > 0 ? Math.min(100, Math.round((value / of) * 100)) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12px] font-semibold text-ppp-charcoal">{label}</span>
        <span className="text-[12.5px] font-bold text-ppp-charcoal tabular-nums">
          {formatCentsFull(value)}
          {of > 0 && <span className="ml-1.5 text-[10.5px] font-medium text-ppp-charcoal-400">{pct}%</span>}
        </span>
      </div>
      <div className="mt-1 h-2 rounded-full bg-ppp-charcoal-100 overflow-hidden">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      {note && <p className="text-[10.5px] text-ppp-charcoal-500 mt-1">{note}</p>}
    </div>
  );
}

export function DealAnalytics({ a }: { a: DealAnalytics }) {
  const unbilled = a.contractToDateCents - a.invoicedCents;
  const marginTone =
    a.marginPct === null ? "text-ppp-charcoal" : a.marginPct < 0 ? "text-rose-700" : a.marginPct < 15 ? "text-amber-700" : "text-emerald-700";

  return (
    <div className="space-y-4">
      <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 space-y-3.5">
        <div>
          <h3 className="text-[13px] font-bold text-ppp-charcoal">Where the contract went</h3>
          <p className="text-[11.5px] text-ppp-charcoal-500 mt-0.5">
            Each bar is measured against the contract to date, so the gaps are the story.
          </p>
        </div>

        <Bar
          label="Contract to date"
          value={a.contractToDateCents}
          of={a.contractToDateCents}
          tone="bg-ppp-navy"
          note={
            a.approvedCoCents !== 0
              ? `${formatCentsFull(a.contractBaseCents)} base ${a.approvedCoCents > 0 ? "+" : "−"} ${formatCentsCompact(Math.abs(a.approvedCoCents))} in approved change orders`
              : "No approved change orders."
          }
        />
        <Bar
          label="Invoiced"
          value={a.invoicedCents}
          of={a.contractToDateCents}
          tone="bg-cc-brand-500"
          note={
            unbilled > 0
              ? `${formatCentsFull(unbilled)} still to bill.`
              : unbilled < 0
              ? `Over-billed by ${formatCentsFull(-unbilled)} — worth checking.`
              : "Fully billed."
          }
        />
        <Bar
          label="Collected"
          value={a.collectedCents}
          of={a.contractToDateCents}
          tone="bg-emerald-500"
          note={
            a.openBalanceCents > 0
              ? `${formatCentsFull(a.openBalanceCents)} outstanding${a.retainageCents > 0 ? `, plus ${formatCentsCompact(a.retainageCents)} retainage held` : ""}.`
              : a.retainageCents > 0
              ? `${formatCentsFull(a.retainageCents)} retainage held back until closeout.`
              : "Everything invoiced has been paid."
          }
        />
        <Bar
          label="Costs"
          value={a.costsCents}
          of={a.contractToDateCents}
          tone="bg-amber-500"
          note={`${formatCentsCompact(a.purchasesCents)} purchases · ${formatCentsCompact(a.crewLaborCents)} crew labour`}
        />
      </div>

      <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h3 className="text-[13px] font-bold text-ppp-charcoal">Margin</h3>
            <p className="text-[11.5px] text-ppp-charcoal-500 mt-0.5">
              Billed minus cost — the same basis as every deal page and report, so this job
              reads the same number everywhere.
            </p>
          </div>
          <div className="text-right shrink-0">
            <div className={`font-condensed text-[26px] font-black tabular-nums leading-none ${marginTone}`}>
              {a.marginPct === null ? "—" : `${a.marginPct}%`}
            </div>
            <div className="text-[11px] text-ppp-charcoal-500 tabular-nums mt-0.5">
              {formatCentsFull(a.marginCents)}
            </div>
          </div>
        </div>
        {a.unratedHours > 0 && (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-[11.5px] text-amber-900">
            <strong className="font-semibold">{a.unratedHours}h</strong> of approved crew time has no
            cost rate on file, so labour cost is short by whatever those hours were worth — and this
            margin is that much too high.
          </p>
        )}
      </div>
    </div>
  );
}
