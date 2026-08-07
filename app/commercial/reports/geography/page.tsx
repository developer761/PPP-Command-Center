import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { getGeographyReport, type GeoRow } from "@/lib/commercial/reports/geography";
import { formatCentsCompact } from "@/lib/commercial/invoices/format";

export const dynamic = "force-dynamic";

export default async function GeographyReportPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");

  const geo = await getGeographyReport();
  const t = geo.totals;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-8 space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-ppp-charcoal">Where the work is</h2>
          <p className="text-[12px] text-ppp-charcoal-500 mt-0.5 max-w-xl">Every job by its site location — which towns and zips drive the most jobs, contract dollars, and margin. Handy for routing crews and picking where to chase more work.</p>
        </div>
        {t.locatedCount > 0 && (
          <a
            href="/api/commercial/reports/geography/export"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-ppp-charcoal-200 bg-surface text-ppp-charcoal-700 text-[13px] font-semibold hover:bg-ppp-charcoal-50 min-h-[44px]"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3" /></svg>
            Export CSV
          </a>
        )}
      </div>

      {t.locatedCount === 0 ? (
        <div className="text-center py-14 px-4 bg-surface border border-ppp-charcoal-100 rounded-xl">
          <p className="text-sm font-semibold text-ppp-charcoal">No job locations yet</p>
          <p className="text-[12px] text-ppp-charcoal-500 mt-1 max-w-sm mx-auto">
            {t.dealCount === 0
              ? "Once deals are logged with a job-site address, this map of where the work is shows up here."
              : `${t.unspecifiedCount} ${t.unspecifiedCount === 1 ? "deal has" : "deals have"} no site address yet. Add the property city/zip on a deal and it appears here.`}
          </p>
          <Link href="/commercial/accounts" className="inline-flex items-center gap-1.5 mt-4 px-3 py-2 rounded-lg border border-ppp-charcoal-200 bg-surface text-[12.5px] font-semibold text-cc-brand-700 hover:bg-ppp-charcoal-50 min-h-[44px]">
            Go to accounts
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </Link>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Tile label="Towns" value={String(t.cityCount)} tone="brand" sub={`${t.zipCount} zip${t.zipCount === 1 ? "" : "s"}`} />
            <Tile label="Located deals" value={String(t.locatedCount)} tone="navy" sub={t.unspecifiedCount > 0 ? `${t.unspecifiedCount} missing address` : "all mapped"} />
            <Tile label="Contract value" value={formatCentsCompact(t.contractCents)} tone="emerald" sub="all located jobs" />
            <Tile label="States" value={String(t.stateCount)} tone="neutral" sub={geo.byState.slice(0, 3).map((s) => s.label).join(" · ") || undefined} />
          </div>

          {t.unspecifiedCount > 0 && (
            <p className="text-[11.5px] text-amber-700 leading-snug bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <span className="font-semibold">{t.unspecifiedCount} {t.unspecifiedCount === 1 ? "deal has" : "deals have"} no site address</span> — they&rsquo;re counted in totals but can&rsquo;t be placed on the map below. Add a property city/zip on each deal to include it.
            </p>
          )}

          <RankSection title="Top towns" caption="by number of jobs" rows={geo.byCity} accent="bg-cc-brand-500" limit={12} />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <RankSection title="Top zip codes" caption="by number of jobs" rows={geo.byZip} accent="bg-ppp-blue-500" limit={10} compact />
            <RankSection title="By state" caption="jobs & contract" rows={geo.byState} accent="bg-ppp-navy-500" limit={10} compact />
          </div>

          <p className="text-[11px] text-ppp-charcoal-400 leading-snug">
            Location comes from each deal&rsquo;s job-site address (property city / state / zip). Contract, cost, and margin match the Job costs report. Margin is contract-based.
          </p>
        </>
      )}
    </div>
  );
}

function RankSection({ title, caption, rows, accent, limit, compact = false }: { title: string; caption: string; rows: GeoRow[]; accent: string; limit: number; compact?: boolean }) {
  const shown = rows.slice(0, limit);
  const maxCount = Math.max(1, ...shown.map((r) => r.dealCount));
  return (
    <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <h3 className="text-[13px] font-bold text-ppp-charcoal flex items-center gap-2">
          <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
          {title}
        </h3>
        <span className="text-[11px] text-ppp-charcoal-400">{caption}</span>
      </div>
      {shown.length === 0 ? (
        <p className="text-[12px] text-ppp-charcoal-400 py-2">No data yet.</p>
      ) : (
        <ul className="space-y-2.5">
          {shown.map((r) => {
            const tone = r.marginPct === null ? "text-ppp-charcoal-400" : r.marginPct < 0 ? "text-rose-700" : r.marginPct < 15 ? "text-amber-700" : "text-emerald-700";
            return (
              <li key={`${r.label}|${r.sub ?? ""}`}>
                <div className="flex items-baseline justify-between gap-2 text-[12.5px] mb-1">
                  <span className="font-semibold text-ppp-charcoal truncate">
                    {r.label}
                    {r.sub && <span className="text-ppp-charcoal-400 font-normal">, {r.sub}</span>}
                    <span className="text-ppp-charcoal-400 font-normal tabular-nums"> · {r.dealCount} {r.dealCount === 1 ? "job" : "jobs"}</span>
                  </span>
                  <span className="tabular-nums text-ppp-charcoal-600 shrink-0">
                    <span className="font-bold text-ppp-charcoal">{formatCentsCompact(r.contractCents)}</span>
                    {!compact && r.marginPct !== null && <span className={`ml-1.5 font-semibold ${tone}`}>{r.marginPct}%</span>}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-ppp-charcoal-100 overflow-hidden">
                  <div className={`h-full rounded-full ${accent}`} style={{ width: `${Math.round((r.dealCount / maxCount) * 100)}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: "brand" | "navy" | "emerald" | "neutral" }) {
  const v = tone === "brand" ? "text-cc-brand-700" : tone === "navy" ? "text-ppp-navy-700" : tone === "emerald" ? "text-emerald-700" : "text-ppp-charcoal";
  return (
    <div className="rounded-xl border border-ppp-charcoal-100 bg-surface px-3 py-2.5">
      <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
      <div className={`font-condensed text-[22px] font-black tabular-nums leading-tight mt-0.5 ${v}`}>{value}</div>
      {sub && <div className="text-[11px] text-ppp-charcoal-500 mt-0.5 truncate">{sub}</div>}
    </div>
  );
}
