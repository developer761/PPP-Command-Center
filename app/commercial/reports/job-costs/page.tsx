import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { getJobCostsReport, COST_BUCKET_COLUMNS, type CostBuckets, type JobCostRow } from "@/lib/commercial/reports/job-costs";
import { formatCentsCompact, formatCentsFull } from "@/lib/commercial/invoices/format";
import { opportunityStatusLabelV2 } from "@/lib/commercial/opportunities/constants";
import { listCommercialInvoices } from "@/lib/commercial/invoices/db";
import { monthlyBilledSeries } from "@/lib/commercial/invoices/monthly";
import { DonutChart, type DonutSegment, type ChartTone } from "@/components/commercial/charts";
import TrendChart from "@/components/trend-chart";

export const dynamic = "force-dynamic";

// One color per cost bucket, reused by the composition bar + chips.
const BUCKET_COLOR: Record<keyof CostBuckets, string> = {
  materials: "bg-cc-brand-500",
  crewLabor: "bg-emerald-500",
  subLabor: "bg-ppp-blue-500",
  subcontractor: "bg-ppp-navy-500",
  equipment: "bg-amber-500",
  permit: "bg-ppp-charcoal-400",
  other: "bg-ppp-charcoal-300",
};
// Same buckets mapped to the donut's ChartTone palette (pie chart).
const BUCKET_TONE: Record<keyof CostBuckets, ChartTone> = {
  materials: "brand",
  crewLabor: "emerald",
  subLabor: "blue",
  subcontractor: "navy",
  equipment: "amber",
  permit: "neutral",
  other: "neutral",
};

export default async function JobCostsReportPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");

  const report = await getJobCostsReport();
  const t = report.totals;
  // Neutral until something has actually been spent. A contract with no costs
  // logged computes to 100%, which reads as a spectacular job and only means
  // nobody has booked a cost yet.
  const marginTone =
    t.marginPct === null || t.totalCostCents === 0
      ? "neutral"
      : t.marginPct < 0
        ? "rose"
        : t.marginPct < 15
          ? "amber"
          : "emerald";

  // Cost composition as a pie (donut) — the seven buckets, non-zero only.
  const costSegments: DonutSegment[] = COST_BUCKET_COLUMNS
    .filter((c) => t.buckets[c.key] > 0)
    .map((c) => ({ label: c.label, value: t.buckets[c.key], tone: BUCKET_TONE[c.key], valueLabel: formatCentsCompact(t.buckets[c.key]) }));

  // Monthly billed-revenue trend (line) across every deal in the report — the
  // same pre-tax, ET-bucketed helper the dashboard uses, so it ties out.
  const allOppIds = new Set(report.groups.flatMap((g) => g.deals.map((d) => d.oppId)));
  const invoices = await listCommercialInvoices({});
  const billingTrend = monthlyBilledSeries(invoices, { months: 6, oppIds: allOppIds, nowIso: new Date().toISOString() });

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-8 space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-ppp-charcoal">Job costs &amp; profit</h2>
          <p className="text-[12px] text-ppp-charcoal-500 mt-0.5 max-w-xl">Every job&rsquo;s real cost — materials, crew, subs — vs its contract, rolled up per GC and company-wide. Margin = billed − cost, the same basis as every deal&rsquo;s Costs tab.</p>
        </div>
        {t.dealCount > 0 && (
          <a
            href="/api/commercial/reports/job-costs/export"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-ppp-charcoal-200 bg-surface text-ppp-charcoal-700 text-[13px] font-semibold hover:bg-ppp-charcoal-50 min-h-[44px]"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3" /></svg>
            Export CSV
          </a>
        )}
      </div>

      {t.dealCount === 0 ? (
        <div className="text-center py-14 px-4 bg-surface border border-ppp-charcoal-100 rounded-xl">
          <p className="text-sm font-semibold text-ppp-charcoal">No job costs yet</p>
          <p className="text-[12px] text-ppp-charcoal-500 mt-1 max-w-sm mx-auto">Once a deal has a contract, billing, or a logged cost, it shows up here with its margin. Log costs on any deal&rsquo;s Transactions tab.</p>
          <Link href="/commercial/accounts" className="inline-flex items-center gap-1.5 mt-4 px-3 py-2 rounded-lg border border-ppp-charcoal-200 bg-surface text-[12.5px] font-semibold text-cc-brand-700 hover:bg-ppp-charcoal-50 min-h-[44px]">
            Go to accounts
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </Link>
        </div>
      ) : (
        <>
          {/* ── Platform totals ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Tile label="Contract value" value={formatCentsCompact(t.contractCents)} tone="navy" sub={`${t.dealCount} ${t.dealCount === 1 ? "deal" : "deals"} · ${t.accountCount} ${t.accountCount === 1 ? "GC" : "GCs"}`} />
            <Tile label="Billed to date" value={formatCentsCompact(t.billedCents)} tone="brand" sub="pre-tax" />
            <Tile label="Total cost" value={formatCentsCompact(t.totalCostCents)} tone="amber" sub="materials · crew · subs" />
            <Tile label="Margin" value={t.marginPct === null ? "—" : `${t.marginPct}%`} tone={marginTone} sub={t.totalCostCents === 0 ? "no costs logged yet" : `${t.marginCents < 0 ? "−" : ""}${formatCentsCompact(Math.abs(t.marginCents))} · billed − cost`} />
          </div>

          {/* ── Monthly billing trend (line) ── */}
          {billingTrend.some((p) => p.value > 0) && (
            <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
              <div className="flex items-baseline justify-between gap-2 mb-2">
                <h3 className="text-[13px] font-bold text-ppp-charcoal flex items-center gap-2">
                  <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
                  Revenue billed / month
                </h3>
                <span className="text-[11px] text-ppp-charcoal-400">last 6 months · pre-tax</span>
              </div>
              <TrendChart data={billingTrend} yFormat="currency-k" colorToken="cc-brand-500" area heightClassName="h-[150px] sm:h-[180px]" />
            </section>
          )}

          {/* ── Company-wide cost composition (pie + chips) ── */}
          <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
            <h3 className="text-[13px] font-bold text-ppp-charcoal mb-3 flex items-center gap-2">
              <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
              Where the money goes · whole company
            </h3>
            {t.totalCostCents > 0 ? (
              <div className="grid grid-cols-1 lg:grid-cols-[auto_1fr] gap-5 items-center">
                <DonutChart size={168} segments={costSegments} centerValue={formatCentsCompact(t.totalCostCents)} centerLabel="total cost" legend={false} />
                <div>
                  <CompositionBar buckets={t.buckets} total={t.totalCostCents} />
                  <BucketChips buckets={t.buckets} total={t.totalCostCents} className="mt-3" />
                </div>
              </div>
            ) : (
              <p className="text-[12px] text-ppp-charcoal-400 py-4 text-center">No job costs logged yet.</p>
            )}
            {t.laborUnratedHours > 0 && (
              <p className="mt-3 text-[11.5px] text-amber-700 leading-snug">
                <span className="font-semibold">{t.laborUnratedHours.toLocaleString()} crew hours</span> have no cost rate set, so crew labor (and profit) is understated. Set rates on the <Link href="/commercial/field-ops/employees" className="font-semibold underline">Crew</Link> page.
              </p>
            )}
          </section>

          {/* ── Per-GC groups → per-deal rows ── */}
          <div className="space-y-2.5">
            {report.groups.map((g) => {
              const gTone =
                g.marginPct === null || g.totalCostCents === 0
                  ? "neutral"
                  : g.marginPct < 0
                    ? "rose"
                    : g.marginPct < 15
                      ? "amber"
                      : "emerald";
              return (
                <details key={g.accountId} className="group bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden" open={report.groups.length <= 3}>
                  <summary className="list-none cursor-pointer px-4 py-3 flex items-center gap-3 min-h-[52px] select-none hover:bg-ppp-charcoal-50/60">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-ppp-charcoal-400 transition-transform group-open:rotate-90 shrink-0"><path d="M9 18l6-6-6-6" /></svg>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] font-bold text-ppp-charcoal truncate">{g.accountName}</div>
                      <div className="text-[11px] text-ppp-charcoal-500 tabular-nums">{g.deals.length} {g.deals.length === 1 ? "deal" : "deals"} · {formatCentsCompact(g.contractCents)} contract · {formatCentsCompact(g.totalCostCents)} cost</div>
                    </div>
                    <MarginBadge pct={g.marginPct} tone={gTone} />
                  </summary>
                  <div className="px-4 pb-4 pt-1 border-t border-ppp-charcoal-50 space-y-3">
                    <BucketChips buckets={g.buckets} total={g.totalCostCents} />
                    <ul className="divide-y divide-ppp-charcoal-100">
                      {g.deals.map((d) => (
                        <DealRow key={d.oppId} d={d} />
                      ))}
                    </ul>
                  </div>
                </details>
              );
            })}
          </div>

          <p className="text-[11px] text-ppp-charcoal-400 leading-snug">
            Scope: every deal incl. closed jobs &amp; pre-sale bids — a strict superset of any single deal&rsquo;s Costs tab. Crew labor is auto from approved time entries; subcontract labor is manually logged. Margin is billed − cost, the same basis as every deal page, so a job reads the same number here and there. Contract is shown for scope context.
          </p>
        </>
      )}
    </div>
  );
}

function DealRow({ d }: { d: JobCostRow }) {
  const tone =
    d.marginPct === null || d.totalCostCents === 0
      ? "neutral"
      : d.marginPct < 0
        ? "rose"
        : d.marginPct < 15
          ? "amber"
          : "emerald";
  return (
    <li>
      <Link
        href={`/commercial/opportunities/${d.oppId}?tab=project&sub=transactions`}
        className="flex items-center gap-3 py-2.5 -mx-1 px-1 rounded-lg hover:bg-ppp-charcoal-50/60 min-h-[44px]"
      >
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-ppp-charcoal truncate">{d.dealName}</div>
          <div className="text-[11px] text-ppp-charcoal-500 tabular-nums">
            <span className="text-ppp-charcoal-400">{opportunityStatusLabelV2(d.status)}</span>
            <span className="text-ppp-charcoal-300"> · </span>
            {formatCentsCompact(d.contractCents)} contract
            <span className="text-ppp-charcoal-300"> · </span>
            {formatCentsCompact(d.billedCents)} billed
            <span className="text-ppp-charcoal-300"> · </span>
            <span className="text-ppp-charcoal-700 font-medium">{formatCentsCompact(d.totalCostCents)} cost</span>
            {d.laborUnratedHours > 0 && <span className="text-amber-700"> · rate missing</span>}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className={`text-[13px] font-bold tabular-nums ${tone === "rose" ? "text-rose-700" : tone === "amber" ? "text-amber-700" : tone === "emerald" ? "text-emerald-700" : "text-ppp-charcoal-400"}`}>
            {d.marginPct === null ? "—" : `${d.marginPct}%`}
          </div>
          <div className="text-[10.5px] text-ppp-charcoal-400 tabular-nums">{d.marginCents < 0 ? "−" : ""}{formatCentsCompact(Math.abs(d.marginCents))}</div>
        </div>
      </Link>
    </li>
  );
}

/** Stacked proportion bar of the seven cost buckets. */
function CompositionBar({ buckets, total }: { buckets: CostBuckets; total: number }) {
  if (total <= 0) return <p className="text-[12px] text-ppp-charcoal-400">No costs logged yet.</p>;
  return (
    <div className="flex h-3 rounded-full overflow-hidden bg-ppp-charcoal-100" role="img" aria-label="Cost composition">
      {COST_BUCKET_COLUMNS.map(({ key }) => {
        const v = buckets[key];
        if (v <= 0) return null;
        return <div key={key} className={BUCKET_COLOR[key]} style={{ width: `${(v / total) * 100}%` }} title={`${key}: ${formatCentsFull(v)}`} />;
      })}
    </div>
  );
}

/** Non-zero cost buckets as labeled chips (label · $ · %). */
function BucketChips({ buckets, total, className = "" }: { buckets: CostBuckets; total: number; className?: string }) {
  const shown = COST_BUCKET_COLUMNS.filter(({ key }) => buckets[key] > 0);
  if (shown.length === 0) return <p className={`text-[11.5px] text-ppp-charcoal-400 ${className}`}>No costs logged.</p>;
  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`}>
      {shown.map(({ key, label }) => (
        <span key={key} className="inline-flex items-center gap-1.5 rounded-lg border border-ppp-charcoal-100 bg-surface px-2.5 py-1 text-[11px]">
          <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${BUCKET_COLOR[key]}`} />
          <span className="font-semibold text-ppp-charcoal-600">{label}</span>
          <span className="tabular-nums font-bold text-ppp-charcoal">{formatCentsFull(buckets[key])}</span>
          {total > 0 && <span className="text-ppp-charcoal-400 tabular-nums">{Math.round((buckets[key] / total) * 100)}%</span>}
        </span>
      ))}
    </div>
  );
}

function MarginBadge({ pct, tone }: { pct: number | null; tone: string }) {
  const cls =
    tone === "rose" ? "bg-rose-50 text-rose-700 border-rose-200"
    : tone === "amber" ? "bg-amber-50 text-amber-800 border-amber-200"
    : tone === "emerald" ? "bg-emerald-50 text-emerald-700 border-emerald-200"
    : "bg-ppp-charcoal-50 text-ppp-charcoal-500 border-ppp-charcoal-200";
  return (
    <span className={`shrink-0 inline-flex items-center rounded-lg border px-2 py-1 text-[12px] font-bold tabular-nums ${cls}`}>
      {pct === null ? "—" : `${pct}%`}
    </span>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: "brand" | "navy" | "amber" | "emerald" | "rose" | "neutral" }) {
  const v =
    tone === "brand" ? "text-cc-brand-700"
    : tone === "navy" ? "text-ppp-navy-700"
    : tone === "amber" ? "text-amber-700"
    : tone === "emerald" ? "text-emerald-700"
    : tone === "rose" ? "text-rose-700"
    : "text-ppp-charcoal";
  return (
    <div className="rounded-xl border border-ppp-charcoal-100 bg-surface px-3 py-2.5">
      <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
      <div className={`font-condensed text-[22px] font-black tabular-nums leading-tight mt-0.5 ${v}`}>{value}</div>
      {sub && <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">{sub}</div>}
    </div>
  );
}
