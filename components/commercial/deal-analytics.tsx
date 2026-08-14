import { formatCentsFull, formatCentsCompact } from "@/lib/commercial/invoices/format";
import {
  DonutChart,
  GaugeRing,
  MiniBars,
  type DonutSegment,
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

  // Money not yet in hand — the one figure the four bars don't state outright:
  // what's left to bill + what's billed-but-unpaid + retainage still held.
  const stillToCome = Math.max(0, unbilled) + a.openBalanceCents + a.retainageCents;
  const hasContract = a.contractToDateCents > 0;
  const marginValueTone =
    a.marginPct === null
      ? "text-ppp-charcoal"
      : a.marginPct < 0
      ? "text-rose-700"
      : a.marginPct < 15
      ? "text-amber-700"
      : "text-emerald-700";

  // Money-flow widths, all on the SAME (pre-tax contract) axis so the bars
  // stack honestly and the GAPS (to-bill, outstanding, retainage) read at a
  // glance. Collected is scaled onto that axis; its label shows the real cash.
  const pct = (v: number) => (hasContract ? Math.max(0, Math.min(100, Math.round((v / a.contractToDateCents) * 100))) : 0);
  const invoicedW = pct(a.invoicedCents);
  const collectedScaled = a.invoicedWithTaxCents > 0 ? Math.round(a.invoicedCents * (a.collectedCents / a.invoicedWithTaxCents)) : 0;
  const collectedW = pct(collectedScaled);
  const toBill = Math.max(0, unbilled);
  const notCollected = a.openBalanceCents + a.retainageCents;

  return (
    <div className="space-y-4">
      {/* THE BOTTOM LINE, first and biggest — profit + margin — then a single
          money-flow visual (Contract → Invoiced → Collected) where each bar sits
          under the one above so the gaps are the finding. Reads even on a job
          with no costs logged (says so, not a flattering 100% margin). */}
      <section className="rounded-xl border border-ppp-charcoal-100 bg-surface overflow-hidden">
        <div className="p-5 bg-gradient-to-br from-emerald-50/50 via-surface to-surface">
          <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-widest text-ppp-charcoal-500">Profit to date</div>
              <div className={`font-condensed text-[38px] sm:text-[44px] font-black leading-[0.92] tabular-nums ${marginValueTone}`}>
                {a.marginPct === null ? "—" : formatCentsFull(a.marginCents)}
              </div>
              <div className="text-[12.5px] text-ppp-charcoal-600 mt-1.5">
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
            <div className="flex gap-7">
              <div>
                <div className="text-[9.5px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Collected</div>
                <div className="font-condensed text-[22px] font-black tabular-nums text-emerald-700 leading-tight">{formatCentsFull(a.collectedCents)}</div>
                <div className="text-[10.5px] text-ppp-charcoal-400 tabular-nums">{collectedPct}% of invoiced</div>
              </div>
              <div>
                <div className="text-[9.5px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Still to come</div>
                <div className="font-condensed text-[22px] font-black tabular-nums text-ppp-navy-700 leading-tight">{formatCentsFull(stillToCome)}</div>
                <div className="text-[10.5px] text-ppp-charcoal-400">bill + owed + retainage</div>
              </div>
            </div>
          </div>

          {hasContract ? (
            <div className="mt-5 space-y-1.5">
              {/* Contract — the full width everything else is measured against. */}
              <div className="flex h-8 rounded-lg overflow-hidden">
                <div className="flex items-center px-3 text-[11px] font-bold text-white bg-ppp-navy-700 whitespace-nowrap tabular-nums w-full">
                  Contract {formatCentsCompact(a.contractToDateCents)}
                </div>
              </div>
              {/* Invoiced + the still-to-bill gap. */}
              <div className="flex h-8 rounded-lg overflow-hidden bg-ppp-charcoal-50 border border-ppp-charcoal-100">
                <div className="flex items-center px-3 text-[11px] font-bold text-white bg-cc-brand-500 whitespace-nowrap tabular-nums overflow-hidden" style={{ flex: `0 0 ${Math.max(invoicedW, toBill > 0 ? 0 : 100)}%` }}>
                  Invoiced {formatCentsCompact(a.invoicedCents)}
                </div>
                {toBill > 0 && (
                  <div className="flex items-center px-3 text-[11px] font-semibold text-ppp-charcoal-500 whitespace-nowrap tabular-nums" style={{ flex: "1" }}>
                    {formatCentsCompact(toBill)} to bill
                  </div>
                )}
              </div>
              {/* Collected + the outstanding/retainage gap. */}
              <div className="flex h-8 rounded-lg overflow-hidden bg-ppp-charcoal-50 border border-ppp-charcoal-100">
                <div className="flex items-center px-3 text-[11px] font-bold text-white bg-emerald-500 whitespace-nowrap tabular-nums overflow-hidden" style={{ flex: `0 0 ${Math.max(collectedW, notCollected > 0 ? 0 : 100)}%` }}>
                  Collected {formatCentsCompact(a.collectedCents)}
                </div>
                {notCollected > 0 && (
                  <div className="flex items-center px-3 text-[11px] font-semibold text-ppp-charcoal-500 whitespace-nowrap tabular-nums" style={{ flex: "1" }}>
                    {a.openBalanceCents > 0 && `${formatCentsCompact(a.openBalanceCents)} outstanding`}
                    {a.openBalanceCents > 0 && a.retainageCents > 0 && " · "}
                    {a.retainageCents > 0 && `${formatCentsCompact(a.retainageCents)} retainage`}
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-[10.5px] text-ppp-charcoal-500">
                <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-ppp-navy-700" />Contract</span>
                <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-cc-brand-500" />Invoiced</span>
                <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-emerald-500" />Collected</span>
                <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-ppp-charcoal-200" />Not yet</span>
              </div>
            </div>
          ) : (
            <p className="mt-4 text-[12.5px] text-ppp-charcoal-400 italic">
              No contract set yet — win the deal and set its contract to see the money flow.
            </p>
          )}
        </div>
      </section>

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
    </div>
  );
}
