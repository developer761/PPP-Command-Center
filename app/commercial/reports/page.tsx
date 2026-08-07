import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { getPipelineReport } from "@/lib/commercial/reports/pipeline";
import { getJobCostsReport } from "@/lib/commercial/reports/job-costs";
import { getArAging } from "@/lib/commercial/reports/ar-aging";
import { getWinLossSummary, currentQuarterRange } from "@/lib/commercial/win-loss/reports";
import { formatCentsCompact } from "@/lib/commercial/invoices/format";

export const dynamic = "force-dynamic";

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
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");

  const quarter = currentQuarterRange();
  const [pipeline, jobCosts, aging, winLoss] = await Promise.all([
    getPipelineReport(),
    getJobCostsReport(),
    getArAging(),
    getWinLossSummary(quarter),
  ]);

  const overdue = aging.totals.total - aging.totals.current;
  const marginTone: Tone = jobCosts.totals.marginPct === null ? "neutral" : jobCosts.totals.marginPct < 0 ? "rose" : jobCosts.totals.marginPct < 15 ? "amber" : "emerald";
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
      primary: { label: "Projected margin", value: jobCosts.totals.marginPct === null ? "—" : `${jobCosts.totals.marginPct}%`, tone: marginTone },
      secondary: { label: "Total cost", value: formatCentsCompact(jobCosts.totals.totalCostCents), tone: "amber" },
    },
    {
      href: "/commercial/reports/ar-aging",
      title: "AR aging",
      blurb: "Open invoice balances by how far past due, per customer.",
      icon: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
      primary: { label: "Total AR", value: formatCentsCompact(aging.totals.total), tone: "brand" },
      secondary: { label: "Overdue", value: formatCentsCompact(overdue), tone: overdue > 0 ? "amber" : "neutral" },
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
