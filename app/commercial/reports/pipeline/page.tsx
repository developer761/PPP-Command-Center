import Link from "next/link";
import { redirect } from "next/navigation";
import { requireReportAccess } from "@/lib/commercial/reports/access";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { getPipelineReport } from "@/lib/commercial/reports/pipeline";
import { getDealReportRows, PIPELINE_MANAGER_SPEC, pipelineManagerRows } from "@/lib/commercial/reports/tomco/opportunities";
import { GroupedReport } from "@/components/commercial/grouped-report";
import { viewIndex } from "@/components/commercial/tomco-report-page";
import { formatCentsCompact, formatCentsFull } from "@/lib/commercial/invoices/format";

export const dynamic = "force-dynamic";

const STAGE_ACCENT: Record<string, string> = {
  qualifying: "bg-ppp-blue-500",
  estimating: "bg-cc-brand-500",
  proposal: "bg-emerald-500",
};

/**
 * THE RECORDS ARE THE REPORT. The charts sit underneath.
 *
 * Karan, 2026-09-16: "have it exactly as Tomco's on Salesforce for everything
 * and give us some extra visuals or stuff at the bottom." This page used to
 * open with four KPI tiles, a funnel and three stage cards — an analytics view
 * of the pipeline, with the actual bids nowhere on it. Brendan's Salesforce
 * report opens with the 39 rows and the GC's phone number, because he works
 * down the list ringing people.
 *
 * So: the grouped table first, totalling $2,116,612.79 to match his report to
 * the cent, and the funnel, the donut and the per-stage detail kept below it
 * for Alex.
 */
const VIEWS = [
  { key: "status", label: "By status" },
  { key: "gc", label: "By GC" },
];

export default async function PipelineReportPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");
  // Report folders: only reports in a folder you belong to (admins see all).
  await requireReportAccess(user.id, user.email, "pipeline");

  const sp = await searchParams;
  const [report, dealRows] = await Promise.all([getPipelineReport(), getDealReportRows()]);
  const bids = pipelineManagerRows(dealRows);
  const t = report.totals;
  const maxBid = Math.max(1, ...report.rows.map((r) => r.bidCents));

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
          {/* The report itself: every open bid, grouped, subtotalled, totalled. */}
          <GroupedReport
            spec={PIPELINE_MANAGER_SPEC}
            rows={bids}
            groupingIndex={viewIndex(VIEWS, sp.view)}
            emptyHint="No open bids right now."
            controls={
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mr-1">Group by</span>
                {VIEWS.map((v, i) => (
                  <Link
                    key={v.key}
                    href={`/commercial/reports/pipeline?view=${v.key}`}
                    aria-current={i === viewIndex(VIEWS, sp.view) ? "true" : undefined}
                    className={`px-2.5 rounded-lg border text-[12px] font-semibold min-h-[36px] inline-flex items-center ${
                      i === viewIndex(VIEWS, sp.view)
                        ? "border-cc-brand-300 bg-cc-brand-50 text-cc-brand-800"
                        : "border-ppp-charcoal-200 bg-surface text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
                    }`}
                  >
                    {v.label}
                  </Link>
                ))}
              </div>
            }
          />

          <h3 className="text-[13px] font-bold text-ppp-charcoal pt-2 flex items-center gap-2">
            <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
            How it breaks down
          </h3>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Tile label="Open opportunities" value={String(t.count)} tone="navy" sub={`${formatCentsCompact(t.avgDealCents)} avg deal`} />
            <Tile label="Bid value" value={formatCentsCompact(t.bidCents)} tone="brand" sub="full, unweighted" />
            <Tile label="Weighted pipeline" value={formatCentsCompact(t.weightedCents)} tone="emerald" sub="expected value" />
            <Tile label="Blended win prob." value={t.probabilityPct === null ? "—" : `${t.probabilityPct}%`} tone="neutral" sub="weighted ÷ bid" />
          </div>

          {/* ONE chart, not three.
              This was a funnel of bars, a weighted-value donut AND four
              per-stage cards — three pictures of the same four numbers, two of
              the cards reading "0 deals · $0 · — · —" because Tomco uses
              neither RFP nor Pending Approval. Karan: "make this chart just
              simpler and only one thing." So: one row per stage that HAS
              deals, carrying everything the cards carried. */}
          <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
            <div className="space-y-3.5">
              {report.rows
                .filter((r) => r.count > 0)
                .map((r) => (
                  <div key={r.status}>
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-full shrink-0 ${STAGE_ACCENT[r.status] ?? "bg-cc-brand-500"}`} />
                      <span className="text-[13px] font-bold text-ppp-charcoal">{r.label}</span>
                      <span className="text-[11.5px] text-ppp-charcoal-500 tabular-nums">
                        {r.count} {r.count === 1 ? "deal" : "deals"} · {formatCentsCompact(r.avgDealCents)} avg
                      </span>
                      <span className="ml-auto text-[13px] font-bold text-ppp-charcoal tabular-nums">
                        {formatCentsFull(r.bidCents)}
                      </span>
                    </div>
                    {/* The bar is the bid; the filled part is what it is worth
                        after the stage's win probability. */}
                    <div className="mt-1.5 h-2.5 rounded-full bg-ppp-charcoal-100 overflow-hidden" role="img"
                      aria-label={`${r.label}: ${formatCentsFull(r.bidCents)} bid, ${formatCentsFull(r.weightedCents)} weighted`}>
                      <div className={`h-full ${STAGE_ACCENT[r.status] ?? "bg-cc-brand-500"}`}
                        style={{ width: `${Math.max(1, Math.round((r.bidCents / maxBid) * 100))}%` }} />
                    </div>
                    <p className="mt-1 text-[11px] text-ppp-charcoal-500 tabular-nums">
                      {formatCentsFull(r.weightedCents)} weighted
                      {r.probabilityPct === null ? "" : ` · ${r.probabilityPct}% win probability`}
                    </p>
                  </div>
                ))}
            </div>
          </section>

          <p className="text-[11px] text-ppp-charcoal-400 leading-snug">
            &ldquo;Open&rdquo; = Qualifying, Estimating, and Proposal-out — the same set as the dashboard Pipeline, so it reconciles. Bid value is the mid of each deal&rsquo;s range; weighted applies each stage&rsquo;s win probability.
          </p>
        </>
      )}
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
