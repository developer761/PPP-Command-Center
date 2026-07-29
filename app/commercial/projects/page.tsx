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
import { derivedOppName, formatOpportunityNumber } from "@/lib/commercial/opportunities/db";
import { oppStatusDisplayLabel } from "@/lib/commercial/opportunities/constants";
import { formatCentsCompact } from "@/lib/commercial/invoices/format";
import { listProjects, summarizeProduction, type ProjectRow } from "@/lib/commercial/projects/db";
import { AIA_STATUS_META } from "@/lib/commercial/aia/constants";
import { KpiTile } from "@/components/commercial/kpi-tile";

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
        <KpiTile label="Active projects" value={String(activeSummary.activeProjects)} sub={includeClosed ? "closed shown below" : "under contract"} tone="navy" icon={<IconHardHat />} />
        <KpiTile label="In production" value={String(activeSummary.inProductionProjects)} sub="in progress or billing" tone="blue" icon={<IconGauge />} />
        <KpiTile label="Contract value" value={formatCentsCompact(activeSummary.contractValueCents)} sub="under management" tone="neutral" icon={<IconContract />} />
        <KpiTile label="Change orders pending" value={String(activeSummary.pendingCoCount)} sub={activeSummary.pendingCoCount > 0 ? `${formatCentsCompact(activeSummary.pendingCoCents)} awaiting` : "none open"} tone={activeSummary.pendingCoCount > 0 ? "amber" : "neutral"} icon={<IconChangeOrder />} />
      </div>

      {/* Filters */}
      <form className="flex items-center gap-2 flex-wrap" action="/commercial/projects">
        <div className="relative flex-1 min-w-[200px]">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="absolute left-3 top-1/2 -translate-y-1/2 text-ppp-charcoal-400 pointer-events-none"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.3-4.3" /></svg>
          <input name="q" defaultValue={search} placeholder="Search projects…" className="w-full pl-9 pr-3 py-2 text-base sm:text-sm bg-white border border-ppp-charcoal-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 min-h-[44px]" />
        </div>
        {includeClosed && <input type="hidden" name="closed" value="1" />}
        <button type="submit" className="px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation">Search</button>
        <Link
          href={`/commercial/projects${includeClosed ? (search ? `?q=${encodeURIComponent(search)}` : "") : `?closed=1${search ? `&q=${encodeURIComponent(search)}` : ""}`}`}
          className={`px-3 py-2 rounded-lg border text-[12px] font-semibold min-h-[44px] inline-flex items-center ${includeClosed ? "bg-cc-brand-50 border-cc-brand-300 text-cc-brand-800" : "bg-white border-ppp-charcoal-200 text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"}`}
        >
          {includeClosed ? "Hiding closed" : "Include closed"}
        </Link>
      </form>

      {projects.length === 0 ? (
        <div className="text-center py-14 px-4 bg-white border border-ppp-charcoal-100 rounded-xl">
          <span aria-hidden className="mx-auto mb-3 inline-flex items-center justify-center h-12 w-12 rounded-full bg-ppp-charcoal-100 text-ppp-charcoal-400">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M2 20h20 M4 20V8l8-5 8 5v12 M9 20v-6h6v6" /></svg>
          </span>
          <p className="text-sm font-semibold text-ppp-charcoal">{search ? "No projects match your search" : "No active projects yet"}</p>
          <p className="text-[12px] text-ppp-charcoal-500 mt-1 max-w-sm mx-auto">A deal becomes a project once it&rsquo;s Won. Change orders + AIA billing live on each project here.</p>
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

/** Left stripe + status pill tone by post-sale phase (emerald→navy→blue→amber→charcoal). */
function projectStatusTone(status: string): { stripe: string; pill: string } {
  switch (status) {
    case "pre_sale_closed":
      return { stripe: "bg-emerald-500", pill: "bg-emerald-50 text-emerald-700 border-emerald-200" };
    case "pre_construction":
      return { stripe: "bg-ppp-navy-500", pill: "bg-ppp-navy-50 text-ppp-navy-700 border-ppp-navy-200" };
    case "in_progress":
      return { stripe: "bg-ppp-blue-500", pill: "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-200" };
    case "billing":
      return { stripe: "bg-amber-500", pill: "bg-amber-50 text-amber-700 border-amber-200" };
    case "post_sale_closed":
      return { stripe: "bg-ppp-charcoal-400", pill: "bg-ppp-charcoal-100 text-ppp-charcoal-600 border-ppp-charcoal-200" };
    default:
      return { stripe: "bg-ppp-charcoal-300", pill: "bg-ppp-charcoal-50 text-ppp-charcoal-600 border-ppp-charcoal-200" };
  }
}

const AIA_TONE_TEXT: Record<"charcoal" | "ppp-blue" | "emerald", string> = {
  charcoal: "text-ppp-charcoal-600",
  "ppp-blue": "text-ppp-blue-700",
  emerald: "text-emerald-700",
};

function ProjectCard({ p }: { p: ProjectRow }) {
  const name = derivedOppName(p.opp, p.accountName);
  const pct = p.percentCompleteBps != null ? Math.min(100, Math.round(p.percentCompleteBps / 100)) : null;
  const oppCode = formatOpportunityNumber(p.opp.project_number);
  const location = p.opp.property_street?.trim() || null;
  const tone = projectStatusTone(p.opp.status);
  const hasContract = p.contractToDateCents > 0;
  const remaining = Math.max(0, p.contractToDateCents - p.completedToDateCents);
  const overviewHref = `/commercial/accounts/${p.accountId}?tab=opportunities&edit=${p.opp.id}`;
  const coHref = `/commercial/accounts/${p.accountId}/change-orders/${p.opp.id}`;
  const aiaHref = `/commercial/accounts/${p.accountId}/aia/${p.opp.id}`;

  return (
    <li className="relative bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden hover:border-cc-brand-200 hover:shadow-md transition-all">
      <span aria-hidden className={`absolute left-0 top-0 bottom-0 w-1 ${tone.stripe}`} />

      <div className="pl-5 pr-4 py-3.5">
        {/* ── Header: opportunity id + status pill ── */}
        <div className="flex items-center justify-between gap-2 mb-1">
          {oppCode ? (
            <span className="text-[9.5px] font-mono text-ppp-navy-600 truncate" title="Opportunity ID">{oppCode}</span>
          ) : <span />}
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[9.5px] font-bold uppercase tracking-wide shrink-0 ${tone.pill}`}>
            {oppStatusDisplayLabel(p.opp.status, p.opp.sub_status)}
          </span>
        </div>

        {/* ── Name + GC · location ── */}
        <Link href={overviewHref} className="block text-[15px] font-bold text-ppp-charcoal hover:text-cc-brand-800 leading-snug break-words">
          {name}
        </Link>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ppp-charcoal-500 min-w-0">
          <span className="truncate font-medium">{p.accountName}</span>
          {location && (
            <>
              <span aria-hidden className="text-ppp-charcoal-300">·</span>
              <span className="truncate">{location}</span>
            </>
          )}
        </div>

        {/* ── Financials panel (or set-up nudge) ── */}
        {hasContract ? (
          <div className="mt-3 rounded-lg border border-ppp-charcoal-100 bg-ppp-charcoal-50/50 px-3 py-2.5">
            <div className="grid grid-cols-3 gap-2 text-center">
              <MoneyStat label="Contract" value={formatCentsCompact(p.contractToDateCents)} />
              <MoneyStat label="Completed" value={formatCentsCompact(p.completedToDateCents)} tone="emerald" />
              <MoneyStat label="Remaining" value={formatCentsCompact(remaining)} />
            </div>
            <div className="mt-2.5">
              <div className="h-1.5 rounded-full bg-ppp-charcoal-200/70 overflow-hidden">
                <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${pct ?? 0}%` }} aria-label={`${pct ?? 0}% complete`} />
              </div>
              <div className="mt-1 flex items-center justify-between text-[10px]">
                <span className="tabular-nums font-semibold text-emerald-700">{pct ?? 0}% complete</span>
                {p.netApprovedCoCents !== 0 && (
                  <span className={`tabular-nums font-medium ${p.netApprovedCoCents < 0 ? "text-rose-700" : "text-emerald-700"}`}>
                    incl. {p.netApprovedCoCents < 0 ? "−" : "+"}{formatCentsCompact(Math.abs(p.netApprovedCoCents))} COs
                  </span>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-dashed border-amber-200 bg-amber-50/40 px-3 py-2.5 text-[11.5px] text-amber-800">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 mt-0.5">
              <path d="M12 9v4 M12 17h.01 M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            </svg>
            <span>{p.hasBilling ? "Set the contract value on the AIA screen to track progress." : "No contract value yet — add the bid range or start AIA billing."}</span>
          </div>
        )}

        {/* ── Status chips: AIA billing + change orders ── */}
        <div className="mt-2.5 flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-ppp-charcoal-100 bg-white px-2 py-1 text-[11px]">
            <span className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-400">AIA</span>
            {p.latestAppNumber != null ? (
              <span className="font-semibold text-ppp-charcoal-700">
                App {p.latestAppNumber} · <span className={p.latestAppStatus ? AIA_TONE_TEXT[AIA_STATUS_META[p.latestAppStatus].tone] : ""}>{p.latestAppStatus ? AIA_STATUS_META[p.latestAppStatus].label : ""}</span>
              </span>
            ) : (
              <span className="text-ppp-charcoal-400">Not started</span>
            )}
          </span>
          <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] ${p.pendingCoCount > 0 ? "border-amber-200 bg-amber-50/50" : "border-ppp-charcoal-100 bg-white"}`}>
            <span className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-400">COs</span>
            {p.pendingCoCount > 0 ? (
              <span className="font-semibold text-amber-700">{p.pendingCoCount} pending</span>
            ) : (
              <span className="text-ppp-charcoal-400">None pending</span>
            )}
          </span>
        </div>
      </div>

      {/* ── Segmented action footer ── */}
      <div className="flex items-stretch border-t border-ppp-charcoal-100 divide-x divide-ppp-charcoal-100 text-[12px] font-semibold">
        <Link href={coHref} className="flex-1 inline-flex items-center justify-center gap-1.5 min-h-[44px] text-ppp-charcoal-700 hover:bg-cc-brand-50 hover:text-cc-brand-800 touch-manipulation">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 12a9 9 0 0 1 15-6.7L21 8 M21 3v5h-5" /></svg>
          Change Orders
        </Link>
        <Link href={aiaHref} className="flex-1 inline-flex items-center justify-center gap-1.5 min-h-[44px] text-ppp-charcoal-700 hover:bg-cc-brand-50 hover:text-cc-brand-800 touch-manipulation">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6" /></svg>
          AIA Billing
        </Link>
      </div>
    </li>
  );
}

function MoneyStat({ label, value, tone }: { label: string; value: string; tone?: "emerald" }) {
  return (
    <div className="min-w-0">
      <div className="text-[8.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400">{label}</div>
      <div className={`font-condensed text-[15px] font-black tabular-nums leading-none mt-0.5 truncate ${tone === "emerald" ? "text-emerald-700" : "text-ppp-charcoal"}`}>{value}</div>
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
