/**
 * Revenue / P&L — portfolio-wide (2026-08). The top-line money story rolled up
 * across every job, reconciled from the SAME shared helpers the deal + tool
 * pages use, so the numbers always match:
 *
 *   Gross revenue = pre-tax billed-to-date (contract billed, incl. approved COs)
 *   Job costs     = Σ project purchases (materials/labor/subs/equipment/permits)
 *   Net profit    = Gross − Costs        Margin % = Net ÷ Gross
 *   (Sales tax is pass-through — never counted as revenue.)
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { formatCentsCompact, formatCentsFull } from "@/lib/commercial/invoices/format";
import { listProjects, summarizeProduction } from "@/lib/commercial/projects/db";
import { listCommercialInvoices } from "@/lib/commercial/invoices/db";
import { derivedOppName } from "@/lib/commercial/opportunities/db";
import { costBreakdownByOpp, emptyCostBreakdown } from "@/lib/commercial/purchases/db";
import { PURCHASE_CATEGORIES, PURCHASE_CATEGORY_META } from "@/lib/commercial/purchases/constants";
import TrendChart from "@/components/trend-chart";
import { DonutChart, GaugeRing, HBars, StatCard, type ChartTone, type DonutSegment } from "@/components/commercial/charts";
import { ProgressMeter } from "@/components/commercial/progress-meter";

export const dynamic = "force-dynamic";

const CATEGORY_TONE: Record<string, ChartTone> = {
  materials: "blue",
  labor: "brand",
  subcontractor: "navy",
  equipment: "amber",
  permit: "emerald",
  other: "neutral",
};

export default async function RevenuePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);

  const [projects, invoices] = await Promise.all([
    listProjects({}),
    listCommercialInvoices({}),
  ]);
  const activeRows = projects.filter((p) => p.opp.status !== "post_sale_closed");
  const summary = summarizeProduction(activeRows);

  // Portfolio cost-by-category (sum every project's breakdown).
  const byOpp = await costBreakdownByOpp(activeRows.map((p) => p.opp.id));
  const costs = emptyCostBreakdown();
  for (const b of byOpp.values()) {
    for (const c of PURCHASE_CATEGORIES) costs[c] += b[c];
    costs.total += b.total;
  }

  // ── P&L (Gross = billed pre-tax, Net = billed − costs) ──
  const grossRevenueCents = summary.billedContractCents;
  const costsCents = costs.total;
  const netProfitCents = grossRevenueCents - costsCents;
  const marginPct = grossRevenueCents > 0 ? Math.round((netProfitCents / grossRevenueCents) * 100) : null;

  // Monthly billed revenue ($K, pre-tax subtotal of issued invoices).
  const revenueMonthly: { label: string; value: number }[] = [];
  {
    const base = new Date();
    for (let m = 5; m >= 0; m--) {
      const d = new Date(base.getFullYear(), base.getMonth() - m, 1);
      const start = d.getTime();
      const end = new Date(base.getFullYear(), base.getMonth() - m + 1, 1).getTime();
      const cents = invoices.reduce((acc, inv) => {
        if (inv.status === "void" || inv.status === "draft") return acc;
        const t = inv.created_at ? new Date(inv.created_at).getTime() : NaN;
        return t >= start && t < end ? acc + inv.subtotal_cents : acc;
      }, 0);
      revenueMonthly.push({ label: d.toLocaleString("en-US", { month: "short" }), value: cents / 100000 });
    }
  }

  // Cost-by-category donut segments.
  const costSegments: DonutSegment[] = PURCHASE_CATEGORIES.filter((c) => costs[c] > 0).map((c) => ({
    label: PURCHASE_CATEGORY_META[c].label,
    value: costs[c],
    tone: CATEGORY_TONE[c] ?? "neutral",
    valueLabel: formatCentsCompact(costs[c]),
  }));

  // Per-project P&L bars (biggest gross first).
  const projectBars = activeRows
    .filter((p) => p.billedContractCents > 0 || p.contractToDateCents > 0)
    .map((p) => {
      const gross = p.billedContractCents;
      const net = gross - p.costsCents;
      const mPct = gross > 0 ? Math.round((net / gross) * 100) : null;
      return { p, gross, net, mPct };
    })
    .sort((a, b) => b.gross - a.gross)
    .slice(0, 8)
    .map(({ p, gross, net, mPct }) => ({
      label: derivedOppName(p.opp, ""),
      value: gross,
      tone: (net < 0 ? "rose" : "emerald") as ChartTone,
      valueLabel: formatCentsCompact(gross),
      sub: p.costsCents > 0 ? `${formatCentsCompact(net)} net · ${mPct ?? 0}% margin` : "no costs logged",
      href: `/commercial/accounts/${p.opp.account_id}?tab=projects&project=${p.opp.id}`,
    }));

  return (
    <div className="space-y-4 sm:space-y-5">
      <div>
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Revenue &amp; P&amp;L</h1>
        <p className="text-[12px] text-ppp-charcoal-500 mt-1">Gross revenue is billed-to-date; net is gross minus job costs. Tax is pass-through — not revenue.</p>
      </div>

      {/* Headline P&L */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Gross revenue" value={formatCentsCompact(grossRevenueCents)} tone="brand" sub="billed to date" spark={revenueMonthly.map((r) => r.value)} sparkLabels={revenueMonthly.map((r) => r.label)} />
        <StatCard label="Job costs" value={formatCentsCompact(costsCents)} tone="amber" sub={costsCents === 0 ? "none logged" : "materials · labor · subs"} />
        <StatCard label="Net profit" value={`${netProfitCents < 0 ? "−" : ""}${formatCentsCompact(Math.abs(netProfitCents))}`} tone={netProfitCents < 0 ? "rose" : "emerald"} sub="gross − costs" />
        <StatCard label="Margin" value={marginPct === null ? "—" : `${marginPct}%`} tone={marginPct === null ? "neutral" : marginPct < 0 ? "rose" : marginPct < 15 ? "amber" : "emerald"} sub={marginPct === null ? "no revenue yet" : "net ÷ gross"} />
      </div>

      {/* Revenue over time + margin gauge */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2 bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h3 className="text-sm font-bold text-ppp-charcoal flex items-center gap-2">
              <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
              Revenue billed
            </h3>
            <span className="text-[11px] text-ppp-charcoal-500">last 6 months · pre-tax</span>
          </div>
          <TrendChart data={revenueMonthly} yFormat="currency-k" colorToken="cc-brand-500" area heightClassName="h-[170px] sm:h-[200px]" />
        </div>
        <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5 flex flex-col items-center justify-center text-center">
          <h3 className="text-[10px] font-bold uppercase tracking-widest text-ppp-charcoal-500 mb-3 self-start flex items-center gap-2">
            <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-emerald-500" />
            Gross margin
          </h3>
          <GaugeRing pct={marginPct ?? 0} tone={marginPct === null ? "neutral" : marginPct < 0 ? "rose" : marginPct < 15 ? "amber" : "emerald"} value={marginPct === null ? "—" : `${marginPct}%`} label="net ÷ gross" size={128} />
          <div className="mt-3 text-[12px] text-ppp-charcoal-500">
            <strong className="text-emerald-700 tabular-nums">{formatCentsCompact(grossRevenueCents)}</strong> gross
            <span className="text-ppp-charcoal-300"> · </span>
            <strong className="tabular-nums text-ppp-charcoal">{formatCentsCompact(costsCents)}</strong> cost
          </div>
        </div>
      </section>

      {/* Cost mix + per-project P&L */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
          <h3 className="text-sm font-bold text-ppp-charcoal mb-3 flex items-center gap-2">
            <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
            Where the money goes
          </h3>
          {costSegments.length > 0 ? (
            <DonutChart size={150} segments={costSegments} centerValue={formatCentsCompact(costsCents)} centerLabel="job costs" />
          ) : (
            <p className="text-[12px] text-ppp-charcoal-400 py-6 text-center">No job costs logged yet. Add costs on any project&rsquo;s Costs &amp; P&amp;L tab.</p>
          )}
        </div>
        <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h3 className="text-sm font-bold text-ppp-charcoal flex items-center gap-2">
              <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
              Revenue by project
            </h3>
            <Link href="/commercial/projects" className="text-[11.5px] font-semibold text-cc-brand-700 hover:underline min-h-[44px] inline-flex items-center px-1">Projects →</Link>
          </div>
          {projectBars.length > 0 ? (
            <HBars items={projectBars} />
          ) : (
            <p className="text-[12px] text-ppp-charcoal-400 py-6 text-center">No billed revenue yet.</p>
          )}
        </div>
      </section>

      {/* Contract completion */}
      {summary.contractValueCents > 0 && (
        <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
          <h3 className="text-sm font-bold text-ppp-charcoal mb-3 flex items-center gap-2">
            <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
            Contract completion
          </h3>
          <ProgressMeter
            label="Billed of contract"
            value={summary.billedContractCents}
            max={summary.contractValueCents}
            tone="blue"
            rightLabel={`${Math.min(100, Math.round((summary.billedContractCents / summary.contractValueCents) * 100))}%`}
            amounts={{ done: formatCentsFull(summary.billedContractCents), total: formatCentsFull(summary.contractValueCents) }}
          />
          <p className="text-[11px] text-ppp-charcoal-500 mt-2">{formatCentsCompact(summary.leftToBillCents)} left to bill across {summary.activeProjects} active project{summary.activeProjects === 1 ? "" : "s"}.</p>
        </section>
      )}
    </div>
  );
}
