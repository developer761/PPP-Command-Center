import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { getPipelineReport } from "@/lib/commercial/reports/pipeline";
import { formatCentsCompact, formatCentsFull } from "@/lib/commercial/invoices/format";

export const dynamic = "force-dynamic";

export default async function PipelineReportPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");

  const report = await getPipelineReport();
  const maxWeighted = Math.max(1, ...report.rows.map((r) => r.weightedCents));

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-8 space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-ppp-charcoal">Pipeline</h2>
          <p className="text-[12px] text-ppp-charcoal-500 mt-0.5">Open opportunities by stage — bid value and weighted (expected) value.</p>
        </div>
        {report.totals.count > 0 && (
          <a
            href="/api/commercial/reports/pipeline/export"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-ppp-charcoal-200 bg-surface text-ppp-charcoal-700 text-[13px] font-semibold hover:bg-ppp-charcoal-50 min-h-[44px]"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3" /></svg>
            Export CSV
          </a>
        )}
      </div>

      {report.totals.count === 0 ? (
        <div className="text-center py-14 px-4 bg-surface border border-ppp-charcoal-100 rounded-xl">
          <p className="text-sm font-semibold text-ppp-charcoal">No open pipeline</p>
          <p className="text-[12px] text-ppp-charcoal-500 mt-1 max-w-sm mx-auto">Nothing is in Qualifying, Estimating, or Proposal right now. New opportunities show up here as you log them.</p>
          <Link
            href="/commercial/opportunities"
            className="inline-flex items-center gap-1.5 mt-4 px-3 py-2 rounded-lg border border-ppp-charcoal-200 bg-surface text-[12.5px] font-semibold text-cc-brand-700 hover:bg-ppp-charcoal-50 min-h-[44px]"
          >
            Go to opportunities
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </Link>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Tile label="Open opportunities" value={String(report.totals.count)} tone="neutral" />
            <Tile label="Bid value" value={formatCentsCompact(report.totals.bidCents)} tone="navy" sub="unweighted" />
            <Tile label="Weighted pipeline" value={formatCentsCompact(report.totals.weightedCents)} tone="brand" sub="expected value" />
          </div>

          <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 space-y-3">
            {report.rows.map((r) => (
              <div key={r.status}>
                <div className="flex items-center justify-between gap-2 text-[12.5px] mb-1">
                  <span className="font-semibold text-ppp-charcoal">{r.label} <span className="text-ppp-charcoal-400 font-normal tabular-nums">· {r.count}</span></span>
                  <span className="tabular-nums text-ppp-charcoal-600">
                    <span className="font-bold text-ppp-charcoal">{formatCentsFull(r.weightedCents)}</span>
                    <span className="text-ppp-charcoal-400"> of {formatCentsFull(r.bidCents)}</span>
                  </span>
                </div>
                <div className="h-2.5 rounded-full bg-ppp-charcoal-100 overflow-hidden">
                  <div className="h-full rounded-full bg-gradient-to-r from-cc-brand-600 to-cc-brand-400" style={{ width: `${Math.round((r.weightedCents / maxWeighted) * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: "brand" | "navy" | "neutral" }) {
  const v = tone === "brand" ? "text-cc-brand-700" : tone === "navy" ? "text-ppp-navy-700" : "text-ppp-charcoal";
  return (
    <div className="rounded-xl border border-ppp-charcoal-100 bg-surface px-3 py-2.5">
      <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
      <div className={`font-condensed text-[22px] font-black tabular-nums leading-tight mt-0.5 ${v}`}>{value}</div>
      {sub && <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">{sub}</div>}
    </div>
  );
}
