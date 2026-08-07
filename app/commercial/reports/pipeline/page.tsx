import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { getPipelineReport, type PipelineStageRow } from "@/lib/commercial/reports/pipeline";
import { formatCentsCompact, formatCentsFull } from "@/lib/commercial/invoices/format";
import { DonutChart, type DonutSegment, type ChartTone } from "@/components/commercial/charts";

export const dynamic = "force-dynamic";

const STAGE_ACCENT: Record<string, string> = {
  qualifying: "bg-ppp-blue-500",
  estimating: "bg-cc-brand-500",
  proposal: "bg-emerald-500",
};
const STAGE_TONE: Record<string, ChartTone> = {
  qualifying: "blue",
  estimating: "brand",
  proposal: "emerald",
};

export default async function PipelineReportPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");

  const report = await getPipelineReport();
  const t = report.totals;
  const maxBid = Math.max(1, ...report.rows.map((r) => r.bidCents));
  const weightedSegments: DonutSegment[] = report.rows
    .filter((r) => r.weightedCents > 0)
    .map((r) => ({ label: r.label, value: r.weightedCents, tone: STAGE_TONE[r.status] ?? "neutral", valueLabel: formatCentsCompact(r.weightedCents) }));

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-8 space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-ppp-charcoal">Pipeline</h2>
          <p className="text-[12px] text-ppp-charcoal-500 mt-0.5 max-w-xl">Open opportunities by stage — full bid value vs the weighted &ldquo;expected&rdquo; value (bid × win probability). The funnel shows how much value sits at each step.</p>
        </div>
        {t.count > 0 && (
          <a
            href="/api/commercial/reports/pipeline/export"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-ppp-charcoal-200 bg-surface text-ppp-charcoal-700 text-[13px] font-semibold hover:bg-ppp-charcoal-50 min-h-[44px]"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3" /></svg>
            Export CSV
          </a>
        )}
      </div>

      {t.count === 0 ? (
        <div className="text-center py-14 px-4 bg-surface border border-ppp-charcoal-100 rounded-xl">
          <p className="text-sm font-semibold text-ppp-charcoal">No open pipeline</p>
          <p className="text-[12px] text-ppp-charcoal-500 mt-1 max-w-sm mx-auto">Nothing is in Qualifying, Estimating, or Proposal right now. New opportunities show up here as you log them.</p>
          <Link href="/commercial/opportunities" className="inline-flex items-center gap-1.5 mt-4 px-3 py-2 rounded-lg border border-ppp-charcoal-200 bg-surface text-[12.5px] font-semibold text-cc-brand-700 hover:bg-ppp-charcoal-50 min-h-[44px]">
            Go to opportunities
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </Link>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Tile label="Open opportunities" value={String(t.count)} tone="navy" sub={`${formatCentsCompact(t.avgDealCents)} avg deal`} />
            <Tile label="Bid value" value={formatCentsCompact(t.bidCents)} tone="brand" sub="full, unweighted" />
            <Tile label="Weighted pipeline" value={formatCentsCompact(t.weightedCents)} tone="emerald" sub="expected value" />
            <Tile label="Blended win prob." value={t.probabilityPct === null ? "—" : `${t.probabilityPct}%`} tone="neutral" sub="weighted ÷ bid" />
          </div>

          {/* Funnel (bars) + weighted-value pie, side by side. */}
          <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
            <h3 className="text-[13px] font-bold text-ppp-charcoal mb-3 flex items-center gap-2">
              <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
              Pipeline funnel
            </h3>
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-5 items-center">
              <div className="space-y-3">
                {report.rows.map((r) => (
                  <StageBar key={r.status} r={r} maxBid={maxBid} accent={STAGE_ACCENT[r.status] ?? "bg-cc-brand-500"} />
                ))}
              </div>
              {weightedSegments.length > 0 && (
                <div className="justify-self-center">
                  <DonutChart size={168} segments={weightedSegments} centerValue={formatCentsCompact(t.weightedCents)} centerLabel="weighted" />
                </div>
              )}
            </div>
          </section>

          {/* Per-stage detail cards. */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {report.rows.map((r) => (
              <div key={r.status} className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4">
                <div className="flex items-center gap-2">
                  <span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-full ${STAGE_ACCENT[r.status] ?? "bg-cc-brand-500"}`} />
                  <h4 className="text-[13px] font-bold text-ppp-charcoal">{r.label}</h4>
                  <span className="ml-auto text-[11px] font-semibold text-ppp-charcoal-500 tabular-nums">{r.count} {r.count === 1 ? "deal" : "deals"}</span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
                  <Metric label="Bid value" value={formatCentsCompact(r.bidCents)} />
                  <Metric label="Weighted" value={formatCentsCompact(r.weightedCents)} />
                  <Metric label="Avg deal" value={r.count > 0 ? formatCentsCompact(r.avgDealCents) : "—"} />
                  <Metric label="Win prob." value={r.probabilityPct === null ? "—" : `${r.probabilityPct}%`} />
                </div>
              </div>
            ))}
          </div>

          <p className="text-[11px] text-ppp-charcoal-400 leading-snug">
            &ldquo;Open&rdquo; = Qualifying, Estimating, and Proposal-out — the same set as the dashboard Pipeline, so it reconciles. Bid value is the mid of each deal&rsquo;s range; weighted applies each stage&rsquo;s win probability.
          </p>
        </>
      )}
    </div>
  );
}

function StageBar({ r, maxBid, accent }: { r: PipelineStageRow; maxBid: number; accent: string }) {
  const bidPct = Math.round((r.bidCents / maxBid) * 100);
  const wtPct = r.bidCents > 0 ? Math.round((r.weightedCents / r.bidCents) * 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between gap-2 text-[12.5px] mb-1">
        <span className="font-semibold text-ppp-charcoal">
          {r.label}
          <span className="text-ppp-charcoal-400 font-normal tabular-nums"> · {r.count}</span>
        </span>
        <span className="tabular-nums text-ppp-charcoal-600">
          <span className="font-bold text-ppp-charcoal">{formatCentsFull(r.weightedCents)}</span>
          <span className="text-ppp-charcoal-400"> of {formatCentsFull(r.bidCents)}</span>
        </span>
      </div>
      {/* Outer bar = bid value (funnel width); inner fill = weighted portion. */}
      <div className="h-3 rounded-full bg-ppp-charcoal-100 overflow-hidden" style={{ width: `${Math.max(6, bidPct)}%` }}>
        <div className={`h-full rounded-full ${accent}`} style={{ width: `${wtPct}%` }} />
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-ppp-charcoal-50/60 px-2 py-1.5">
      <div className="text-[9.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400">{label}</div>
      <div className="text-[12.5px] font-bold tabular-nums text-ppp-charcoal mt-0.5">{value}</div>
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: "brand" | "navy" | "emerald" | "neutral" }) {
  const v = tone === "brand" ? "text-cc-brand-700" : tone === "navy" ? "text-ppp-navy-700" : tone === "emerald" ? "text-emerald-700" : "text-ppp-charcoal";
  return (
    <div className="rounded-xl border border-ppp-charcoal-100 bg-surface px-3 py-2.5">
      <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
      <div className={`font-condensed text-[22px] font-black tabular-nums leading-tight mt-0.5 ${v}`}>{value}</div>
      {sub && <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">{sub}</div>}
    </div>
  );
}
