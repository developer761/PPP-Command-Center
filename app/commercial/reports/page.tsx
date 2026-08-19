import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { getPipelineReport } from "@/lib/commercial/reports/pipeline";
import { getJobCostsReport } from "@/lib/commercial/reports/job-costs";
import { getArAging } from "@/lib/commercial/reports/ar-aging";
import { getReceivablesReport } from "@/lib/commercial/reports/receivables";
import { getLaborReport } from "@/lib/commercial/reports/labor";
import { getEstimatorReport } from "@/lib/commercial/reports/estimator";
import { getCashFlowReport } from "@/lib/commercial/reports/cash-flow";
import { getChangeOrderVendorReport } from "@/lib/commercial/reports/change-orders-vendors";
import { etTodayIso } from "@/lib/date-et";
import { getGeographyReport } from "@/lib/commercial/reports/geography";
import { getWinLossSummary, currentQuarterRange } from "@/lib/commercial/win-loss/reports";
import { formatCentsCompact } from "@/lib/commercial/invoices/format";
import { listCommercialInvoices } from "@/lib/commercial/invoices/db";
import { monthlyBilledSeries } from "@/lib/commercial/invoices/monthly";
import { COST_BUCKET_COLUMNS, type CostBuckets } from "@/lib/commercial/reports/job-costs";
import { DonutChart, type DonutSegment, type ChartTone } from "@/components/commercial/charts";
import TrendChart from "@/components/trend-chart";

export const dynamic = "force-dynamic";

const BUCKET_TONE: Record<keyof CostBuckets, ChartTone> = {
  materials: "brand", crewLabor: "emerald", subLabor: "blue", subcontractor: "navy", equipment: "amber", permit: "neutral", other: "neutral",
};

type Tone = "brand" | "navy" | "amber" | "emerald" | "rose" | "neutral";
const toneText: Record<Tone, string> = {
  brand: "text-cc-brand-700",
  navy: "text-ppp-navy-700",
  amber: "text-amber-700",
  emerald: "text-emerald-700",
  rose: "text-rose-700",
  neutral: "text-ppp-charcoal",
};

export default async function ReportsOverviewPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  // The estimator report is per-person performance and redirects a rep. A card
  // that offers it and then bounces you is worse than one that isn't there —
  // same reason the inline-edit pencil is hidden rather than shown-and-failing.
  const { normalizeRole } = await import("@/lib/auth/roles");
  const { isAdminEmail } = await import("@/lib/auth/admin");
  const viewerRole = normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(user.email));
  const canSeePeople = viewerRole === "admin" || viewerRole === "account_manager";
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");

  const quarter = currentQuarterRange();
  // The labour card summarises the CURRENT MONTH, matching the report page's
  // own default, so the number on the card is the number you land on.
  const labourToday = etTodayIso();
  const labourRange = { fromYmd: `${labourToday.slice(0, 7)}-01`, toYmd: labourToday };
  // The estimator card summarises the YEAR, matching that report's default —
  // a month of bids is too few to read a win rate from.
  const estYearLabel = labourToday.slice(0, 4);
  const estimatorRange = { fromYmd: `${estYearLabel}-01-01`, toYmd: labourToday };
  // Six months on the card, matching that report's own default.
  const cashFromTotal = Number(labourToday.slice(0, 4)) * 12 + (Number(labourToday.slice(5, 7)) - 1) - 5;
  const cashRange = {
    fromYmd: `${Math.floor(cashFromTotal / 12)}-${String((cashFromTotal % 12) + 1).padStart(2, "0")}-01`,
    toYmd: labourToday,
  };
  const [pipeline, jobCosts, aging, winLoss, geo, labor, estimator, cash, coVendor, receivables] = await Promise.all([
    getPipelineReport(),
    getJobCostsReport(),
    getArAging(),
    getWinLossSummary(quarter),
    getGeographyReport(),
    getLaborReport(labourRange),
    getEstimatorReport(estimatorRange),
    getCashFlowReport(cashRange),
    // Year to date, matching that report's own default preset.
    getChangeOrderVendorReport({ fromYmd: `${estYearLabel}-01-01`, toYmd: labourToday }),
    getReceivablesReport(),
  ]);
  const topTown = geo.byCity[0] ?? null;

  // Snapshot visuals for the landing: company billing trend (line) + cost mix (pie).
  const allOppIds = new Set(jobCosts.groups.flatMap((g) => g.deals.map((d) => d.oppId)));
  const invoices = await listCommercialInvoices({});
  const billingTrend = monthlyBilledSeries(invoices, { months: 6, oppIds: allOppIds, nowIso: new Date().toISOString() });
  const hasTrend = billingTrend.some((p) => p.value > 0);
  const costSegments: DonutSegment[] = COST_BUCKET_COLUMNS
    .filter((c) => jobCosts.totals.buckets[c.key] > 0)
    .map((c) => ({ label: c.label, value: jobCosts.totals.buckets[c.key], tone: BUCKET_TONE[c.key], valueLabel: formatCentsCompact(jobCosts.totals.buckets[c.key]) }));

  const overdue = aging.totals.total - aging.totals.current;
  const marginTone: Tone =
    jobCosts.totals.marginPct === null || jobCosts.totals.totalCostCents === 0
      ? "neutral"
      : jobCosts.totals.marginPct < 0
        ? "rose"
        : jobCosts.totals.marginPct < 15
          ? "amber"
          : "emerald";
  const hasHeadToHead = winLoss.wonCount + winLoss.lostCount > 0;

  const cards: {
    href: string;
    title: string;
    blurb: string;
    icon: React.ReactNode;
    primary: { label: string; value: string; tone: Tone };
    secondary: { label: string; value: string; tone?: Tone };
  }[] = [
    {
      href: "/commercial/reports/pipeline",
      title: "Pipeline",
      blurb: "Open opportunities by stage — bid vs weighted value.",
      icon: <path d="M3 3v18h18 M7 14l3-3 4 4 5-6" />,
      primary: { label: "Weighted pipeline", value: formatCentsCompact(pipeline.totals.weightedCents), tone: "brand" },
      secondary: { label: "Open", value: `${pipeline.totals.count} ${pipeline.totals.count === 1 ? "deal" : "deals"}` },
    },
    {
      href: "/commercial/reports/job-costs",
      title: "Job costs & profit",
      blurb: "Real cost vs contract per deal, GC, and company-wide.",
      icon: <path d="M12 2v20 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />,
      primary: { label: "Margin", value: jobCosts.totals.marginPct === null ? "—" : `${jobCosts.totals.marginPct}%`, tone: marginTone },
      secondary: { label: "Total cost", value: formatCentsCompact(jobCosts.totals.totalCostCents), tone: "amber" },
    },
    {
      href: "/commercial/reports/geography",
      title: "Where the work is",
      blurb: "Jobs by town, zip, and state — where the work concentrates.",
      icon: <><path d="M12 21s-6-5.686-6-10a6 6 0 1 1 12 0c0 4.314-6 10-6 10z" /><circle cx="12" cy="11" r="2" /></>,
      primary: { label: "Towns", value: String(geo.totals.cityCount), tone: "navy" },
      secondary: { label: "Top town", value: topTown ? `${topTown.label} · ${topTown.dealCount}` : "—" },
    },
    {
      href: "/commercial/reports/cash-flow",
      title: "Cash flow & collections",
      blurb: "What actually arrived, and how long it took.",
      icon: <><path d="M3 6h18v12H3z" /><circle cx="12" cy="12" r="2.5" /><path d="M7 12h.01 M17 12h.01" /></>,
      primary: { label: "Collected · 6 mo", value: formatCentsCompact(cash.totals.collectedCents), tone: "emerald" as const },
      secondary: {
        label: "Days to pay",
        value: cash.totals.avgDaysToPay === null ? "—" : `${cash.totals.avgDaysToPay}d`,
        tone: cash.totals.avgDaysToPay !== null && cash.totals.avgDaysToPay > 60 ? "amber" as const : undefined,
      },
    },
    {
      // Alex's ask (2026-08-19), modelled on Mary's hand-kept sheet. Sits above
      // AR aging because it answers the question he actually asks — what's out
      // and what's happening with it — where aging answers "who is late".
      href: "/commercial/reports/receivables",
      title: "Receivables",
      blurb: "Every job with money out, invoices and AIA together, with a chase note per item.",
      icon: <><path d="M3 6h18v12H3z" /><path d="M3 10h18" /><path d="M7 14h4" /></>,
      primary: { label: "Outstanding", value: formatCentsCompact(receivables.totalOpenCents), tone: "brand" as const },
      secondary: {
        label: "Past due",
        value: formatCentsCompact(receivables.overdueCents),
        tone: receivables.overdueCents > 0 ? "amber" as const : "neutral" as const,
      },
    },
    {
      href: "/commercial/reports/ar-aging",
      title: "AR aging",
      blurb: "Open invoice balances by how far past due, per customer.",
      icon: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
      primary: { label: "Total AR", value: formatCentsCompact(aging.totals.total), tone: "brand" },
      secondary: { label: "Overdue", value: formatCentsCompact(overdue), tone: overdue > 0 ? "amber" : "neutral" },
    },
    ...(canSeePeople ? [{
      href: "/commercial/reports/estimator",
      title: "Estimator performance",
      blurb: "Bids sent, win rate, and how fast they go out.",
      icon: <><path d="M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></>,
      primary: {
        label: `Win rate · ${estYearLabel}`,
        value: estimator.totals.winRatePct === null ? "—" : `${estimator.totals.winRatePct}%`,
        tone: "emerald" as const,
      },
      secondary: { label: "Bids sent", value: String(estimator.totals.bidsSent) },
    }] : []),
    {
      href: "/commercial/reports/labor",
      title: "Labour & payroll",
      blurb: "Approved crew hours and cost, by person and by job.",
      icon: <><path d="M9 21V9a3 3 0 0 1 6 0v12" /><path d="M3 21h18 M5 21V11l7-5 7 5v10" /></>,
      primary: { label: "Hours (this month)", value: `${labor.totalHours.toLocaleString("en-US", { maximumFractionDigits: 0 })}h`, tone: "navy" },
      secondary: {
        label: labor.unratedHours > 0 ? "Unpriced hours" : "Labour cost",
        value: labor.unratedHours > 0
          ? `${labor.unratedHours.toLocaleString("en-US", { maximumFractionDigits: 0 })}h`
          : formatCentsCompact(labor.totalCostCents),
        tone: labor.unratedHours > 0 ? "amber" : "neutral",
      },
    },
    {
      href: "/commercial/reports/change-orders",
      title: "Change orders & vendor spend",
      blurb: "Scope beyond contract, and who got paid.",
      icon: <><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></>,
      primary: {
        label: coVendor.co.unbilledCents > 0 ? "Approved, unbilled" : "Added scope",
        value: formatCentsCompact(coVendor.co.unbilledCents > 0 ? coVendor.co.unbilledCents : coVendor.co.approvedAddCents),
        tone: coVendor.co.unbilledCents > 0 ? "amber" as const : "emerald" as const,
      },
      secondary: { label: "Vendor spend", value: formatCentsCompact(coVendor.vendorTotalCents) },
    },
    {
      href: "/commercial/reports/win-loss",
      title: "Win / loss",
      blurb: "What we win, what we lose, and why. Quarterly review fuel.",
      icon: <><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6 M18 9h1.5a2.5 2.5 0 0 0 0-5H18 M6 4h12v5a6 6 0 0 1-12 0V4z M9 20h6 M12 15v5" /></>,
      primary: { label: `Win rate · ${quarter.label}`, value: hasHeadToHead ? `${winLoss.winRatePct}%` : "—", tone: "emerald" },
      secondary: { label: "Won", value: formatCentsCompact(winLoss.wonValueCents), tone: "emerald" },
    },
  ];

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-8 space-y-4">
      <div>
        <h2 className="text-lg font-bold text-ppp-charcoal">Reports</h2>
        <p className="text-[12px] text-ppp-charcoal-500 mt-0.5 max-w-xl">The whole company at a glance — sales pipeline, job profitability, receivables, and win/loss. Open any report to drill in and export.</p>
      </div>

      {/* Snapshot visuals — billing trend (line) + cost mix (pie). */}
      {(hasTrend || costSegments.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {hasTrend && (
            <div className="lg:col-span-2 bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
              <div className="flex items-baseline justify-between gap-2 mb-2">
                <h3 className="text-[13px] font-bold text-ppp-charcoal">Revenue billed / month</h3>
                <span className="text-[11px] text-ppp-charcoal-400">last 6 months</span>
              </div>
              <TrendChart data={billingTrend} yFormat="currency-k" colorToken="cc-brand-500" area heightClassName="h-[150px]" />
            </div>
          )}
          {costSegments.length > 0 && (
            <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
              <h3 className="text-[13px] font-bold text-ppp-charcoal mb-2">Cost mix</h3>
              <DonutChart size={132} segments={costSegments} centerValue={formatCentsCompact(jobCosts.totals.totalCostCents)} centerLabel="total cost" legend={false} />
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {cards.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="group bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5 hover:border-cc-brand-300 hover:shadow-sm transition-colors flex flex-col"
          >
            <div className="flex items-start gap-3">
              <span aria-hidden className="inline-flex items-center justify-center h-9 w-9 rounded-lg bg-cc-brand-50 text-cc-brand-700 shrink-0">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{c.icon}</svg>
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <h3 className="text-[14px] font-bold text-ppp-charcoal">{c.title}</h3>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-ppp-charcoal-300 group-hover:text-cc-brand-600 group-hover:translate-x-0.5 transition-all"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                </div>
                <p className="text-[11.5px] text-ppp-charcoal-500 mt-0.5 leading-snug">{c.blurb}</p>
              </div>
            </div>
            <div className="mt-3 pt-3 border-t border-ppp-charcoal-50 grid grid-cols-2 gap-3">
              <Metric label={c.primary.label} value={c.primary.value} tone={c.primary.tone} />
              <Metric label={c.secondary.label} value={c.secondary.value} tone={c.secondary.tone ?? "neutral"} />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500 truncate">{label}</div>
      <div className={`font-condensed text-[20px] font-black tabular-nums leading-tight mt-0.5 ${toneText[tone]}`}>{value}</div>
    </div>
  );
}
