/**
 * Projects — the cross-account production command center (2026-07-28). Every
 * active job (post-sale opportunity) with its contract sum to date, open change
 * orders, and latest AIA application status + % complete. Each card is the
 * jumping-off point to that project's Change Orders / AIA Billing / Overview.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { formatCentsCompact, formatCentsFull } from "@/lib/commercial/invoices/format";
import { listProjects, summarizeProduction } from "@/lib/commercial/projects/db";
import { derivedOppName } from "@/lib/commercial/opportunities/db";
import { KpiTile } from "@/components/commercial/kpi-tile";
import { ProjectCard } from "@/components/commercial/project-card";
import { DonutChart, HBars, type ChartTone } from "@/components/commercial/charts";
import { ProgressMeter } from "@/components/commercial/progress-meter";
import { SubmitButton } from "@/components/commercial/submit-button";

type SP = Promise<{ q?: string; closed?: string }>;

export default async function ProjectsPage({ searchParams }: { searchParams: SP }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);

  const sp = await searchParams;
  const search = typeof sp.q === "string" ? sp.q : "";
  const includeClosed = sp.closed === "1";
  const projects = await listProjects({ search, includeClosed });

  // KPIs describe ACTIVE work — never inflated by the "include closed" list
  // toggle (the toggle only changes what the list below shows).
  const activeSummary = summarizeProduction(projects.filter((p) => p.opp.status !== "post_sale_closed"));

  // Per-project contract bars (biggest first) for the portfolio chart.
  const activeProjectRows = projects.filter((p) => p.opp.status !== "post_sale_closed" && p.contractToDateCents > 0);
  const projectBars = activeProjectRows
    .slice()
    .sort((a, b) => b.contractToDateCents - a.contractToDateCents)
    .slice(0, 7)
    .map((p) => {
      const pctBilled = p.contractToDateCents > 0 ? Math.min(100, Math.round((p.billedContractCents / p.contractToDateCents) * 100)) : 0;
      return {
        label: derivedOppName(p.opp, ""),
        value: p.contractToDateCents,
        tone: (pctBilled >= 100 ? "emerald" : "blue") as ChartTone,
        valueLabel: formatCentsCompact(p.contractToDateCents),
        sub: `${formatCentsCompact(p.billedContractCents)} billed · ${pctBilled}%`,
        href: `/commercial/opportunities/${p.opp.id}`,
      };
    });
  const billedOfContractPct = activeSummary.contractValueCents > 0 ? Math.min(100, Math.round((activeSummary.billedContractCents / activeSummary.contractValueCents) * 100)) : 0;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Projects</h1>
          <p className="text-[12px] text-ppp-charcoal-500 mt-1">Every job under contract — change orders, AIA billing, and progress in one place.</p>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiTile label="Under contract" value={formatCentsCompact(activeSummary.contractValueCents)} sub={`${activeSummary.activeProjects} active project${activeSummary.activeProjects === 1 ? "" : "s"}`} tone="navy" icon={<IconContract />} />
        {/* WITH tax, matching the paid sub-line and Outstanding beside it, and the
            account-360 tile. This showed the PRE-tax total, so a taxed job read
            "$108,875 paid" under "Invoiced $100,000" and Outstanding came out
            larger than Invoiced. The pre-tax figure is still the right basis for
            the "Billed of contract" meter below — a contract is pre-tax — which
            is why both numbers exist. */}
        <KpiTile label="Invoiced" value={formatCentsCompact(activeSummary.invoicedCents)} sub={`${formatCentsCompact(activeSummary.paidCents)} paid · incl. tax`} tone="blue" icon={<IconGauge />} />
        {/* Pre-tax, like the contract it measures against — the two money bases
            on this row are deliberate: contract figures are pre-tax, cash
            figures include it. */}
        <KpiTile label="Left to bill" value={formatCentsCompact(activeSummary.leftToBillCents)} sub="contract − billed, pre-tax" tone="neutral" icon={<IconHardHat />} />
        <KpiTile label="Outstanding" value={formatCentsCompact(activeSummary.outstandingCents)} sub={activeSummary.pendingCoCount > 0 ? `${activeSummary.pendingCoCount} CO${activeSummary.pendingCoCount === 1 ? "" : "s"} pending` : "unpaid balance"} tone={activeSummary.outstandingCents > 0 ? "amber" : "neutral"} icon={<IconChangeOrder />} />
      </div>

      {/* Portfolio — contract-mix donut + per-project bars (shown once there's a
          job under contract). */}
      {activeSummary.activeProjects > 0 && (
        <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
          <h2 className="text-sm font-bold text-ppp-charcoal mb-3 flex items-center gap-2">
            <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
            Portfolio
          </h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-center">
            <div className="flex items-center justify-center">
              <DonutChart
                size={158}
                segments={[
                  { label: "Billed", value: activeSummary.billedContractCents, tone: "emerald", valueLabel: formatCentsCompact(activeSummary.billedContractCents) },
                  { label: "Left to bill", value: activeSummary.leftToBillCents, tone: "blue", valueLabel: formatCentsCompact(activeSummary.leftToBillCents) },
                ]}
                centerValue={formatCentsCompact(activeSummary.contractValueCents)}
                centerLabel="contract"
              />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500 mb-2">Contract by project</div>
              {projectBars.length > 0 ? (
                <HBars items={projectBars} />
              ) : (
                <p className="text-[12px] text-ppp-charcoal-400">Set a contract value on a project to see it here.</p>
              )}
            </div>
          </div>
          {activeSummary.contractValueCents > 0 && (
            <div className="mt-4">
              <ProgressMeter
                label="Billed of contract"
                value={activeSummary.billedContractCents}
                max={activeSummary.contractValueCents}
                tone={billedOfContractPct === 100 ? "emerald" : "blue"}
                rightLabel={`${billedOfContractPct}%`}
                amounts={{ done: formatCentsFull(activeSummary.billedContractCents), total: formatCentsFull(activeSummary.contractValueCents) }}
              />
            </div>
          )}
        </section>
      )}

      {/* Filters */}
      <form className="flex items-center gap-2 flex-wrap" action="/commercial/projects">
        <div className="relative flex-1 min-w-[200px]">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="absolute left-3 top-1/2 -translate-y-1/2 text-ppp-charcoal-400 pointer-events-none"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.3-4.3" /></svg>
          <input name="q" defaultValue={search} placeholder="Search projects…" className="w-full pl-9 pr-3 py-2 text-base sm:text-sm bg-surface border border-ppp-charcoal-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 min-h-[44px]" />
        </div>
        {includeClosed && <input type="hidden" name="closed" value="1" />}
        <SubmitButton
          className="px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation"
        >Search</SubmitButton>
        <Link
          href={`/commercial/projects${includeClosed ? (search ? `?q=${encodeURIComponent(search)}` : "") : `?closed=1${search ? `&q=${encodeURIComponent(search)}` : ""}`}`}
          className={`px-3 py-2 rounded-lg border text-[12px] font-semibold min-h-[44px] inline-flex items-center ${includeClosed ? "bg-cc-brand-50 border-cc-brand-300 text-cc-brand-800" : "bg-surface border-ppp-charcoal-200 text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"}`}
        >
          {includeClosed ? "Hiding closed" : "Include closed"}
        </Link>
      </form>

      {projects.length === 0 ? (
        <div className="text-center py-14 px-4 bg-surface border border-ppp-charcoal-100 rounded-xl">
          <span aria-hidden className="mx-auto mb-3 inline-flex items-center justify-center h-12 w-12 rounded-full bg-ppp-charcoal-100 text-ppp-charcoal-400">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M2 20h20 M4 20V8l8-5 8 5v12 M9 20v-6h6v6" /></svg>
          </span>
          <p className="text-sm font-semibold text-ppp-charcoal">{search ? "No projects match your search" : "No active projects yet"}</p>
          <p className="text-[12px] text-ppp-charcoal-500 mt-1 max-w-sm mx-auto">An opportunity becomes a project once it&rsquo;s Won. Change orders + AIA billing live on each project here.</p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {projects.map((p) => (
            <ProjectCard key={p.opp.id} p={p} />
          ))}
        </ul>
      )}
    </div>
  );
}


function IconHardHat() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 18h20 M4 18v-3a8 8 0 0 1 16 0v3 M10 6.3V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2.3" />
    </svg>
  );
}
function IconGauge() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 14l4-4 M3.5 18a9 9 0 1 1 17 0z" />
    </svg>
  );
}
function IconContract() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13h6 M9 17h4" />
    </svg>
  );
}
function IconChangeOrder() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-15 6.7L3 16 M3 21v-5h5" />
    </svg>
  );
}
