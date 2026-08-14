import { formatCentsFull, formatCentsCompact } from "@/lib/commercial/invoices/format";
import {
  DonutChart,
  GaugeRing,
  HBars,
  MiniBars,
  StatCard,
  type DonutSegment,
  type HBarItem,
} from "@/components/commercial/charts";

/**
 * Analytics for one job.
 *
 * Karan 2026-08-13: *"the analytics page shouldn't just be lines — add KPI
 * blocks, line graphs, pie charts etc where it makes sense."*
 *
 * Fair. The first version was four progress bars and some prose, which is a
 * summary, not analytics. Each visual here earns its place by answering a
 * different SHAPE of question:
 *
 *  - **KPI blocks** — the four numbers anyone would ask for out loud.
 *  - **Billing over time** — is money going out steadily, or in one lump at
 *    the end? A total can't show that; a series can.
 *  - **A donut of costs** — cost is a composition question ("where did it
 *    go"), which is the one thing a pie is genuinely good at.
 *  - **A gauge for margin** — one number against a target reads faster as a
 *    dial than as text.
 *  - **The money chain as bars** — kept, because contract → invoiced →
 *    collected is a sequence where each step can only shrink, and the GAPS
 *    are the finding.
 *
 * Deliberately per-deal. Company-wide questions have four reports already.
 */

export type DealAnalytics = {
  contractBaseCents: number;
  approvedCoCents: number;
  contractToDateCents: number;
  /** PRE-TAX — the basis the contract is in, so the two can be compared. */
  invoicedCents: number;
  /** WITH tax — what the GC was actually asked for, and what `collected`
   *  is measured against. Sales tax is collected for the state, not for us,
   *  so it belongs nowhere near the contract comparison. */
  invoicedWithTaxCents: number;
  collectedCents: number;
  openBalanceCents: number;
  retainageCents: number;
  costsCents: number;
  crewLaborCents: number;
  purchasesCents: number;
  /** Purchases split by category — the donut. */
  costsByCategory: { materials: number; labor: number; subcontractor: number; equipment: number; permit: number; other: number };
  marginCents: number;
  marginPct: number | null;
  unratedHours: number;
  /** Invoiced per month, oldest first — the billing shape over time. */
  billingByMonth: { label: string; invoicedCents: number; collectedCents: number }[];
};

export function DealAnalytics({ a }: { a: DealAnalytics }) {
  const unbilled = a.contractToDateCents - a.invoicedCents;
  // Collected is a with-tax figure, so it is measured against the with-tax
  // invoiced total. Dividing it by the pre-tax one would report over-collection
  // on every taxable job.
  const collectedPct =
    a.invoicedWithTaxCents > 0
      ? Math.round((a.collectedCents / a.invoicedWithTaxCents) * 100)
      : 0;

  const costSegments: DonutSegment[] = (
    [
      ["Materials", a.costsByCategory.materials, "brand"],
      ["Subcontractors", a.costsByCategory.subcontractor, "amber"],
      ["Subcontract labour", a.costsByCategory.labor, "blue"],
      ["Crew labour", a.crewLaborCents, "emerald"],
      ["Equipment", a.costsByCategory.equipment, "navy"],
      ["Permits", a.costsByCategory.permit, "neutral"],
      ["Other", a.costsByCategory.other, "neutral"],
    ] as const
  )
    .filter(([, v]) => v > 0)
    .map(([label, value, tone]) => ({
      label,
      value,
      tone,
      valueLabel: formatCentsCompact(value),
    }));

  // The money chain. Each step can only shrink from the one above it, so the
  // gaps between the bars are what there is to notice.
  const chain: HBarItem[] = [
    {
      label: "Contract to date",
      value: a.contractToDateCents,
      tone: "navy",
      valueLabel: formatCentsFull(a.contractToDateCents),
      sub:
        a.approvedCoCents !== 0
          ? `${formatCentsCompact(a.contractBaseCents)} base ${a.approvedCoCents > 0 ? "+" : "−"} ${formatCentsCompact(Math.abs(a.approvedCoCents))} change orders`
          : "No approved change orders",
    },
    {
      label: "Invoiced",
      value: a.invoicedCents,
      tone: "brand",
      valueLabel: formatCentsFull(a.invoicedCents),
      sub:
        unbilled > 0
          ? `${formatCentsCompact(unbilled)} still to bill`
          : unbilled < 0
          ? `Over-billed by ${formatCentsCompact(-unbilled)}`
          : "Fully billed",
    },
    {
      label: "Collected",
      // Scaled onto the pre-tax axis so the bar sits honestly beside the other
      // three; the LABEL shows the real money received.
      value: a.invoicedWithTaxCents > 0 ? Math.round(a.invoicedCents * (a.collectedCents / a.invoicedWithTaxCents)) : 0,
      tone: "emerald",
      valueLabel: formatCentsFull(a.collectedCents),
      sub:
        a.openBalanceCents > 0
          ? `${formatCentsCompact(a.openBalanceCents)} outstanding`
          : a.retainageCents > 0
          ? `${formatCentsCompact(a.retainageCents)} retainage held`
          : "All paid",
    },
    {
      label: "Costs",
      value: a.costsCents,
      tone: "amber",
      valueLabel: formatCentsFull(a.costsCents),
      sub: `${formatCentsCompact(a.purchasesCents)} purchases · ${formatCentsCompact(a.crewLaborCents)} crew`,
    },
  ];

  // Money not yet in hand — the one figure the four bars don't state outright:
  // what's left to bill + what's billed-but-unpaid + retainage still held.
  const stillToCome = Math.max(0, unbilled) + a.openBalanceCents + a.retainageCents;
  const marginValueTone =
    a.marginPct === null
      ? "text-ppp-charcoal"
      : a.marginPct < 0
      ? "text-rose-700"
      : a.marginPct < 15
      ? "text-amber-700"
      : "text-emerald-700";

  return (
    <div className="space-y-4">
      {/* THE BOTTOM LINE, first and biggest — the one answer this tab exists to
          give. Reads even on a job with no costs logged yet (says so, rather
          than flattering a 100% margin), so a thin job isn't a blank screen. */}
      <div className="rounded-xl border border-ppp-charcoal-100 bg-gradient-to-br from-ppp-charcoal-50/70 to-surface p-5">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-widest text-ppp-charcoal-500">Bottom line</div>
            <div className={`font-condensed text-[34px] font-black leading-none tabular-nums ${marginValueTone}`}>
              {a.marginPct === null ? "—" : formatCentsFull(a.marginCents)}
            </div>
            <div className="text-[12px] text-ppp-charcoal-600 mt-1">
              {a.marginPct === null ? (
                "Set a contract to see the margin."
              ) : (
                <>
                  <strong className="font-semibold">{a.marginPct}% margin</strong> · billed minus cost
                  {a.costsCents === 0 && <span className="text-amber-700"> · no costs logged yet</span>}
                </>
              )}
            </div>
          </div>
          <div className="flex gap-6">
            <div>
              <div className="text-[9.5px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Collected</div>
              <div className="font-condensed text-[21px] font-black tabular-nums text-emerald-700 leading-tight">{formatCentsFull(a.collectedCents)}</div>
              <div className="text-[10.5px] text-ppp-charcoal-500 tabular-nums">{collectedPct}% of invoiced</div>
            </div>
            <div>
              <div className="text-[9.5px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Still to come</div>
              <div className="font-condensed text-[21px] font-black tabular-nums text-ppp-charcoal leading-tight">{formatCentsFull(stillToCome)}</div>
              <div className="text-[10.5px] text-ppp-charcoal-500">to bill + owed + retainage</div>
            </div>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Contract to date"
          value={formatCentsFull(a.contractToDateCents)}
          sub={a.approvedCoCents !== 0 ? `incl. ${formatCentsCompact(a.approvedCoCents)} in COs` : "no change orders"}
          tone="navy"
        />
        <StatCard
          label="Invoiced"
          value={formatCentsFull(a.invoicedCents)}
          sub={unbilled > 0 ? `${formatCentsCompact(unbilled)} left to bill` : unbilled < 0 ? "over-billed" : "fully billed"}
          tone="brand"
          spark={a.billingByMonth.map((m) => m.invoicedCents)}
          sparkLabels={a.billingByMonth.map((m) => m.label)}
        />
        <StatCard
          label="Collected"
          value={formatCentsFull(a.collectedCents)}
          sub={`${collectedPct}% of what we've invoiced (incl. tax)`}
          tone="emerald"
          spark={a.billingByMonth.map((m) => m.collectedCents)}
          sparkLabels={a.billingByMonth.map((m) => m.label)}
        />
        <StatCard
          label="Margin"
          value={a.marginPct === null ? "—" : `${a.marginPct}%`}
          sub={formatCentsFull(a.marginCents)}
          tone={a.marginPct === null ? "neutral" : a.marginPct < 0 ? "rose" : a.marginPct < 15 ? "amber" : "emerald"}
        />
      </div>

      {a.unratedHours > 0 && (
        <p className="rounded-lg border border-amber-200 bg-amber-50/60 px-4 py-2.5 text-[12px] text-amber-900">
          <strong className="font-semibold">{a.unratedHours}h</strong> of approved crew time has no cost
          rate on file. Labour cost is short by whatever those hours were worth, so the margin above is
          that much <strong className="font-semibold">too high</strong>.
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Composition — the one question a pie answers well. */}
        <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4">
          <h3 className="text-[13px] font-bold text-ppp-charcoal">Where the cost went</h3>
          <p className="text-[11.5px] text-ppp-charcoal-500 mt-0.5 mb-3">
            Purchases plus in-house crew time, priced at each worker&rsquo;s rate on the day.
          </p>
          {costSegments.length === 0 ? (
            <p className="text-[12.5px] text-ppp-charcoal-400 italic py-6 text-center">
              Nothing logged yet. Costs land here from the deal&rsquo;s Transactions tab and from approved
              crew hours.
            </p>
          ) : (
            <DonutChart segments={costSegments} centerLabel="Total" centerValue={formatCentsCompact(a.costsCents)} />
          )}
        </div>

        {/* One number against a target reads faster as a dial. */}
        <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4">
          <h3 className="text-[13px] font-bold text-ppp-charcoal">Margin</h3>
          <p className="text-[11.5px] text-ppp-charcoal-500 mt-0.5 mb-3">
            Billed minus cost — the same basis as every deal page and report, so this job reads the same
            number everywhere.
          </p>
          <div className="flex items-center justify-center py-2">
            {/* 40% as the full sweep — a commercial paint job at 40 is
                excellent, so the dial reads meaningfully across the range
                people actually see rather than hugging one end. Clamped at 0
                because a ring cannot show a negative; the value below it does. */}
            <GaugeRing
              pct={Math.max(0, Math.min(100, ((a.marginPct ?? 0) / 40) * 100))}
              value={a.marginPct === null ? "—" : `${a.marginPct}%`}
              label={formatCentsFull(a.marginCents)}
              tone={a.marginPct === null ? "neutral" : a.marginPct < 0 ? "rose" : a.marginPct < 15 ? "amber" : "emerald"}
            />
          </div>
        </div>
      </div>

      {/* Steady progress billing or one lump at the end? A total can't say. */}
      {a.billingByMonth.length > 1 && (
        <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
            <div>
              <h3 className="text-[13px] font-bold text-ppp-charcoal">Billing over time</h3>
              <p className="text-[11.5px] text-ppp-charcoal-500 mt-0.5">
                Invoiced each month against what came in. A widening gap is money going out faster than it
                comes back.
              </p>
            </div>
            <div className="flex items-center gap-3 text-[10.5px] text-ppp-charcoal-500">
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-cc-brand-500" />Invoiced</span>
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-emerald-500" />Collected</span>
            </div>
          </div>
          <MiniBars
            values={a.billingByMonth.map((m) => m.invoicedCents)}
            labels={a.billingByMonth.map((m) => m.label)}
            tone="brand"
          />
          <div className="mt-2">
            <MiniBars
              values={a.billingByMonth.map((m) => m.collectedCents)}
              labels={a.billingByMonth.map((m) => m.label)}
              tone="emerald"
            />
          </div>
        </div>
      )}

      <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4">
        <h3 className="text-[13px] font-bold text-ppp-charcoal">The money chain</h3>
        <p className="text-[11.5px] text-ppp-charcoal-500 mt-0.5 mb-3">
          Each step can only shrink from the one above it, so the gaps are the story.
        </p>
        <HBars items={chain} max={Math.max(a.contractToDateCents, a.invoicedCents, a.costsCents, 1)} />
      </div>
    </div>
  );
}
