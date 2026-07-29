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
import { derivedOppName } from "@/lib/commercial/opportunities/db";
import { oppStatusDisplayLabel } from "@/lib/commercial/opportunities/constants";
import { formatCentsFull, formatCentsCompact } from "@/lib/commercial/invoices/format";
import { listProjects, type ProjectRow } from "@/lib/commercial/projects/db";
import { AIA_STATUS_META } from "@/lib/commercial/aia/constants";

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

  const totalContract = projects.reduce((s, p) => s + p.contractToDateCents, 0);
  const totalPendingCo = projects.reduce((s, p) => s + p.pendingCoCount, 0);
  const inBilling = projects.filter((p) => p.opp.status === "in_progress" || p.opp.status === "billing").length;

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
        <Kpi label="Active projects" value={String(projects.length)} tone="neutral" />
        <Kpi label="In production" value={String(inBilling)} tone="blue" />
        <Kpi label="Contract value" value={formatCentsCompact(totalContract)} tone="neutral" />
        <Kpi label="Change orders pending" value={String(totalPendingCo)} tone={totalPendingCo > 0 ? "amber" : "neutral"} />
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
          <span aria-hidden className="mx-auto mb-3 inline-flex items-center justify-center h-12 w-12 rounded-full bg-cc-brand-50 text-cc-brand-500">
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

function ProjectCard({ p }: { p: ProjectRow }) {
  const name = derivedOppName(p.opp, p.accountName);
  const pct = p.percentCompleteBps != null ? Math.min(100, Math.round(p.percentCompleteBps / 100)) : null;
  const overviewHref = `/commercial/accounts/${p.accountId}?tab=opportunities&edit=${p.opp.id}`;
  const coHref = `/commercial/accounts/${p.accountId}/change-orders/${p.opp.id}`;
  const aiaHref = `/commercial/accounts/${p.accountId}/aia/${p.opp.id}`;
  return (
    <li className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 hover:border-cc-brand-200 hover:shadow-sm transition-all">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <Link href={overviewHref} className="text-[14px] font-bold text-ppp-charcoal hover:text-cc-brand-800 break-words">{name}</Link>
          <div className="mt-1 flex items-center gap-2 flex-wrap text-[11px]">
            <span className="inline-flex items-center px-2 py-0.5 rounded-full border bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-200 font-semibold">
              {oppStatusDisplayLabel(p.opp.status, p.opp.sub_status)}
            </span>
            <span className="text-ppp-charcoal-500 truncate">{p.accountName}</span>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Contract to date</div>
          {p.contractToDateCents === 0 ? (
            <div className="font-condensed text-lg font-black text-ppp-charcoal-300 tabular-nums leading-none">—</div>
          ) : (
            <div className="font-condensed text-lg font-black text-ppp-charcoal tabular-nums leading-none">{formatCentsFull(p.contractToDateCents)}</div>
          )}
          {p.netApprovedCoCents !== 0 && (
            <div className={`text-[10.5px] font-medium tabular-nums ${p.netApprovedCoCents < 0 ? "text-rose-700" : "text-emerald-700"}`}>
              incl. {p.netApprovedCoCents < 0 ? "−" : "+"}{formatCentsFull(Math.abs(p.netApprovedCoCents))} COs
            </div>
          )}
        </div>
      </div>

      {/* Progress + billing status */}
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-3 text-[11px]">
        <div>
          <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-400">Progress</div>
          {pct != null ? (
            <>
              <div className="mt-1 h-1.5 rounded-full bg-ppp-charcoal-100 overflow-hidden">
                <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} aria-label={`${pct}% complete`} />
              </div>
              <div className="text-ppp-charcoal-600 mt-0.5 tabular-nums">{pct}% complete</div>
            </>
          ) : p.hasBilling ? (
            <div className="text-amber-700 mt-1 italic">Set the contract value</div>
          ) : (
            <div className="text-ppp-charcoal-400 mt-1 italic">No billing yet</div>
          )}
        </div>
        <div>
          <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-400">AIA billing</div>
          <div className="mt-1 text-ppp-charcoal-700">
            {p.latestAppNumber != null ? (
              <>App No. {p.latestAppNumber} · <span className="font-semibold">{p.latestAppStatus ? AIA_STATUS_META[p.latestAppStatus].label : ""}</span></>
            ) : (
              <span className="text-ppp-charcoal-400 italic">Not started</span>
            )}
          </div>
        </div>
        <div>
          <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-400">Change orders</div>
          <div className="mt-1 text-ppp-charcoal-700">
            {p.pendingCoCount > 0 ? <span className="text-amber-700 font-semibold">{p.pendingCoCount} pending</span> : <span className="text-ppp-charcoal-400">None pending</span>}
          </div>
        </div>
      </div>

      {/* Quick links */}
      <div className="mt-3 pt-3 border-t border-ppp-charcoal-100 flex items-center gap-1.5 flex-wrap">
        <Link href={coHref} className="inline-flex items-center px-3 py-1.5 rounded-lg border border-ppp-charcoal-200 text-[12px] font-semibold text-ppp-charcoal-700 hover:bg-cc-brand-50 hover:border-cc-brand-300 hover:text-cc-brand-800 min-h-[36px]">Change Orders →</Link>
        <Link href={aiaHref} className="inline-flex items-center px-3 py-1.5 rounded-lg border border-ppp-charcoal-200 text-[12px] font-semibold text-ppp-charcoal-700 hover:bg-cc-brand-50 hover:border-cc-brand-300 hover:text-cc-brand-800 min-h-[36px]">AIA Billing →</Link>
        <Link href={overviewHref} className="inline-flex items-center px-3 py-1.5 rounded-lg text-[12px] font-medium text-ppp-charcoal-500 hover:text-cc-brand-700 min-h-[36px]">Open deal</Link>
      </div>
    </li>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone: "neutral" | "blue" | "amber" }) {
  const ring = tone === "blue" ? "border-ppp-blue-200 bg-gradient-to-br from-white to-ppp-blue-50/50" : tone === "amber" ? "border-amber-200 bg-gradient-to-br from-white to-amber-50/40" : "border-ppp-charcoal-100 bg-white";
  const stripe = tone === "blue" ? "bg-ppp-blue-500" : tone === "amber" ? "bg-amber-500" : "bg-ppp-charcoal-200";
  return (
    <div className={`relative border rounded-xl px-4 py-3 overflow-hidden shadow-sm ${ring}`}>
      <span aria-hidden className={`absolute left-0 top-0 bottom-0 w-[3px] ${stripe}`} />
      <div className="text-[12px] font-semibold text-ppp-charcoal-700">{label}</div>
      <div className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal mt-1 leading-none tabular-nums">{value}</div>
    </div>
  );
}
