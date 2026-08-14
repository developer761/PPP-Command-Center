/**
 * Costs & P&L — cross-account index (sidebar tab, Phase 2). Every project grouped
 * by account with its job margin; tap one to open that project's Costs & P&L.
 * Same data (`listProjects`) as the Projects tab + the deal card, so the cost /
 * margin numbers always agree.
 */
import { redirect } from "next/navigation";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { listProjects, summarizeProduction } from "@/lib/commercial/projects/db";
import { marginFrom } from "@/lib/commercial/projects/financials";
import { formatCentsCompact } from "@/lib/commercial/invoices/format";
import { PostJobToolIndex, type ToolStatusTone } from "@/components/commercial/post-job-tool-index";

export const dynamic = "force-dynamic";

export default async function CostsIndexPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);

  const projects = await listProjects({ includeClosed: true });
  const summary = summarizeProduction(projects);
  const withCosts = projects.filter((p) => p.costsCents > 0).length;
  // Portfolio gross margin on the BILLED basis — the SAME basis as the
  // per-project rows below (marginFrom(billedContract, costs)) and the deal page
  // they link to. The tile used to divide margin by the full CONTRACT while the
  // rows divided by what's BILLED, so the headline read ~46% over a list of
  // 9–12% jobs: one screen, two answers (audit M4).
  const portfolioBilledCents = projects.reduce((s, p) => s + p.billedContractCents, 0);
  const portfolioMargin = marginFrom(portfolioBilledCents, summary.costsCents);

  return (
    <PostJobToolIndex
      title="Transactions"
      subtitle="What each job actually costs — materials, labor, subs — vs its contract, so you see the margin."
      icon={<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 2v20 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>}
      projects={projects}
      emptyHint="Job costs live on a project (a Won opportunity). Win an opportunity and log its costs to see margin here."
      status={(p): { label: string; tone: ToolStatusTone } => {
        if (p.costsCents === 0) return { label: "No costs", tone: "neutral" };
        // Billed-based, same as the deal page this links to. It used to show
        // the contract-based number, so a job's margin changed when you clicked
        // through to it.
        const m = marginFrom(p.billedContractCents, p.costsCents);
        if (m.pct == null) return { label: `${formatCentsCompact(p.costsCents)} cost`, tone: "neutral" };
        const tone: ToolStatusTone = m.pct < 0 ? "rose" : m.pct < 15 ? "amber" : "emerald";
        return { label: `${m.pct}% margin`, tone };
      }}
      hrefFor={(p) => `/commercial/accounts/${p.accountId}/costs/${p.opp.id}?back=/commercial/post-job/costs`}
      accent="brand"
      kpis={
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Tile label="Total job costs" value={formatCentsCompact(summary.costsCents)} tone={summary.costsCents > 0 ? "rose" : "neutral"} />
          <Tile label="Contract (all projects)" value={formatCentsCompact(summary.contractValueCents)} tone="neutral" />
          <Tile label="Gross margin" value={`${portfolioMargin.cents < 0 ? "−" : ""}${formatCentsCompact(Math.abs(portfolioMargin.cents))}${portfolioMargin.pct == null ? "" : ` · ${portfolioMargin.pct}%`}`} tone={portfolioMargin.cents < 0 ? "rose" : "emerald"} />
          <Tile label="Projects with costs" value={String(withCosts)} tone="neutral" />
        </div>
      }
    />
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: "amber" | "emerald" | "rose" | "neutral" }) {
  const cls = tone === "amber" ? "text-amber-700" : tone === "emerald" ? "text-emerald-700" : tone === "rose" ? "text-rose-700" : "text-ppp-charcoal";
  return (
    <div className="bg-surface border border-ppp-charcoal-100 rounded-xl px-4 py-3 shadow-sm">
      <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
      <div className={`font-condensed text-xl sm:text-2xl font-black tabular-nums mt-1 ${cls}`}>{value}</div>
    </div>
  );
}
