import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  currentQuarterRange,
  previousQuarterRange,
  currentYearRange,
  previousYearRange,
  getWinLossSummary,
  getCompetitorBreakdown,
  getDecidingFactorBreakdown,
  getLessonsLearnedFeed,
  etMidnightToUTC,
} from "@/lib/commercial/win-loss/reports";
import { opportunityLossReasonLabel } from "@/lib/commercial/opportunities/db";
import DatePicker from "@/components/commercial/date-picker";

type Preset = "this_quarter" | "last_quarter" | "this_year" | "last_year";
const PRESETS: ReadonlyArray<{ key: Preset; label: string }> = [
  { key: "this_quarter", label: "This Quarter" },
  { key: "last_quarter", label: "Last Quarter" },
  { key: "this_year", label: "This Year" },
  { key: "last_year", label: "Last Year" },
];

/**
 * Win/Loss Reports — Alex's quarterly review surface. Aggregates every
 * `commercial_win_loss_debrief` row into:
 *   - top-line KPIs (win rate, total $ won, total $ lost, no-bid count)
 *   - competitor leaderboard (who we lose to most)
 *   - deciding-factor breakdown (why we're losing)
 *   - lessons-learned feed (the "what we'd do differently" column)
 *
 * Date range defaults to current quarter; query param `?from=…&to=…`
 * lets Alex pick any window for the upcoming review.
 *
 * Mobile-first: KPI cards stack on small screens, breakdowns become
 * card lists, the lessons feed is the bottom of the scroll.
 */

export const dynamic = "force-dynamic";

type SP = Promise<{ from?: string; to?: string; preset?: string }>;

function formatCents(cents: number): string {
  if (cents === 0) return "$0";
  const dollars = cents / 100;
  if (Math.abs(dollars) >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(2)}M`;
  if (Math.abs(dollars) >= 10_000) return `$${Math.round(dollars / 1000)}k`;
  return `$${dollars.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/** Split bare "YYYY-MM-DD" into calendar parts for etMidnightToUTC.
 *  Returns null on any non-YYYY-MM-DD input to short-circuit invalid
 *  custom ranges. */
function parseYmdParts(ymd: string): { year: number; monthIdx: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const monthIdx = parseInt(m[2], 10) - 1;
  const day = parseInt(m[3], 10);
  if (year < 1970 || year > 2100 || monthIdx < 0 || monthIdx > 11 || day < 1 || day > 31) return null;
  return { year, monthIdx, day };
}

/** Format a Date in America/New_York, "Jul 1, 2026" style. */
function fmtEtDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function parseRange(sp: { from?: string; to?: string; preset?: string }): {
  fromIso: string;
  toIso: string;
  label: string;
  /** What kind of range the user is viewing — drives chip highlight state. */
  activeKey: Preset | "custom";
  /** Echoed back into the custom-range form's date inputs so the picker
   *  remembers what was last submitted (or shows today as a sane default). */
  fromYmd: string;
  toYmd: string;
  /** True iff the user supplied from/to but we couldn't accept it. The page
   *  renders an inline hint so the fallback isn't invisible. */
  rejected: boolean;
} {
  // Custom range always wins if both dates are present + valid.
  if (sp.from && sp.to) {
    // Parse bare YYYY-MM-DD → { year, monthIdx, day } for etMidnightToUTC.
    // Round 3 recheck audit 2026-07-01: an earlier attempt used
    // `new Date(ymd + "T12:00:00Z")` which is 8am ET, silently excluding
    // debriefs stamped between midnight and 8am ET on `sp.from` AND
    // debriefs from 8am ET onward on `sp.to`. The presets (currentQuarter,
    // etc.) already use etMidnightToUTC — the custom range must too.
    const fromParts = parseYmdParts(sp.from);
    const toParts = parseYmdParts(sp.to);
    if (fromParts && toParts) {
      const fromIso = etMidnightToUTC(fromParts.year, fromParts.monthIdx, fromParts.day).toISOString();
      // Push toIso forward one day so the last day is INCLUSIVE (matches
      // the .lt() DB filter — without this, picking "to=Jun 30" silently
      // drops every Jun 30 debrief).
      const toMidnight = etMidnightToUTC(toParts.year, toParts.monthIdx, toParts.day + 1);
      const toIso = toMidnight.toISOString();
      if (new Date(fromIso).getTime() <= new Date(toIso).getTime()) {
        return {
          fromIso,
          toIso,
          label: `${fmtEtDate(new Date(fromIso))} – ${fmtEtDate(new Date(toMidnight.getTime() - 86_400_000))}`,
          activeKey: "custom",
          fromYmd: sp.from,
          toYmd: sp.to,
          rejected: false,
        };
      }
    }
  }
  const supplied = !!(sp.from || sp.to);
  // Otherwise pick a preset (default: this quarter).
  const preset = (sp.preset as Preset) ?? "this_quarter";
  let r: ReturnType<typeof currentQuarterRange>;
  let key: Preset;
  switch (preset) {
    case "last_quarter": r = previousQuarterRange(); key = "last_quarter"; break;
    case "this_year": r = currentYearRange(); key = "this_year"; break;
    case "last_year": r = previousYearRange(); key = "last_year"; break;
    case "this_quarter":
    default: r = currentQuarterRange(); key = "this_quarter"; break;
  }
  // For the custom-form defaults, pre-fill with the active preset's bounds.
  return {
    fromIso: r.fromIso,
    toIso: r.toIso,
    label: r.label,
    activeKey: key,
    fromYmd: r.fromIso.slice(0, 10),
    toYmd: new Date(new Date(r.toIso).getTime() - 86_400_000).toISOString().slice(0, 10),
    rejected: supplied,
  };
}

export default async function WinLossReportsPage({ searchParams }: { searchParams: SP }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const sp = await searchParams;
  const range = parseRange(sp);

  const [summary, competitors, factors, lessons] = await Promise.all([
    getWinLossSummary(range),
    getCompetitorBreakdown(range, 10),
    getDecidingFactorBreakdown(range),
    getLessonsLearnedFeed(range, 20),
  ]);

  const totalCompetitorMentions = competitors.reduce((sum, c) => sum + c.total_count, 0);
  const totalFactorMentions = factors.reduce((sum, f) => sum + f.count, 0);

  return (
    <div className="space-y-5">
      {/* ─── Hero — same PageHeader shape as every other Commercial CC
          surface. 3px×40px red accent bar → title → subtitle. ─── */}
      <header>
        <span aria-hidden className="block h-[3px] w-10 rounded-full mb-3 bg-cc-brand-600" />
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ppp-charcoal">
            Win/Loss Reports
          </h1>
          <span className="inline-flex items-center text-[10px] font-bold tracking-widest uppercase text-cc-brand-700 bg-cc-brand-50 border border-cc-brand-200 px-2 py-0.5 rounded">
            {range.label}
          </span>
        </div>
        <p className="text-sm text-ppp-charcoal-500">
          Aggregated debrief data — what we&apos;re winning, what we&apos;re losing, and why. Quarterly review fuel.
        </p>
      </header>

      {/* ─── Toolbar with period picker (preset chips + custom range form) ─── */}
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((p) => {
            const active = range.activeKey === p.key;
            return (
              <Link
                key={p.key}
                href={p.key === "this_quarter"
                  ? "/commercial/reports/win-loss"
                  : `/commercial/reports/win-loss?preset=${p.key}`}
                className={`inline-flex items-center px-3.5 py-2 rounded-lg text-[13px] font-semibold border min-h-[44px] touch-manipulation transition-colors ${
                  active
                    ? "bg-cc-brand-600 text-white border-cc-brand-700 shadow-sm shadow-cc-brand-600/30"
                    : "bg-white text-ppp-charcoal-700 border-ppp-charcoal-200 hover:border-ppp-charcoal-300 hover:bg-ppp-charcoal-50"
                }`}
                aria-current={active ? "page" : undefined}
              >
                {p.label}
              </Link>
            );
          })}
          <span className="text-[11px] text-ppp-charcoal-400 mx-1 hidden sm:inline" aria-hidden>
            or custom range:
          </span>
          <form
            action="/commercial/reports/win-loss"
            method="GET"
            className="inline-flex flex-wrap items-center gap-2"
          >
            <div className="w-[168px]">
              <DatePicker
                id="rng_from"
                name="from"
                defaultValue={range.fromYmd}
                placeholder="From date"
                ariaLabel="From date"
              />
            </div>
            <span className="text-[12px] text-ppp-charcoal-400" aria-hidden>→</span>
            <div className="w-[168px]">
              <DatePicker
                id="rng_to"
                name="to"
                defaultValue={range.toYmd}
                placeholder="To date"
                ariaLabel="To date"
              />
            </div>
            <button
              type="submit"
              className={`inline-flex items-center px-3.5 py-2 rounded-lg text-[13px] font-semibold border min-h-[44px] touch-manipulation transition-colors ${
                range.activeKey === "custom"
                  ? "bg-cc-brand-600 text-white border-cc-brand-700 shadow-sm shadow-cc-brand-600/30"
                  : "bg-white text-ppp-charcoal-700 border-ppp-charcoal-200 hover:border-ppp-charcoal-300 hover:bg-ppp-charcoal-50"
              }`}
            >
              Apply
            </button>
          </form>
        </div>
        {range.rejected && (
          <p className="text-[11px] text-rose-700">
            Custom range was invalid — showing <span className="font-semibold">{range.label}</span> instead.
          </p>
        )}
      </div>

      {/* KPI strip. Karan 2026-07-09 polish: added a "$ won ratio" tile
          because count-based win rate hides big-vs-small deal dynamics
          — winning one $500k job while losing three $50k jobs is a
          different story than the reverse, and only the $ split shows
          it. Win rate reads "—" instead of "0%" when there were no
          head-to-heads (only no-bids), so an empty period doesn't look
          like a wipeout. */}
      <section className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KpiCard
          tone="cc-brand"
          label="Win rate"
          value={summary.wonCount + summary.lostCount > 0 ? `${summary.winRatePct}%` : "—"}
          sub={
            summary.wonCount + summary.lostCount > 0
              ? `${summary.wonCount} won · ${summary.lostCount} lost`
              : "no head-to-heads yet"
          }
        />
        <KpiCard
          tone="cc-brand"
          label="$ won ratio"
          value={(() => {
            const totalValue = summary.wonValueCents + summary.lostValueCents;
            if (totalValue === 0) return "—";
            return `${Math.round((summary.wonValueCents / totalValue) * 100)}%`;
          })()}
          sub="of every $ we bid on"
        />
        <KpiCard
          tone="blue"
          label="Won $"
          value={formatCents(summary.wonValueCents)}
          sub={summary.wonCount === 1 ? "1 deal" : `${summary.wonCount} deals`}
        />
        <KpiCard
          tone="rose"
          label="Lost $"
          value={formatCents(summary.lostValueCents)}
          sub={summary.lostCount === 1 ? "1 deal" : `${summary.lostCount} deals`}
        />
        <KpiCard
          tone="neutral"
          label="No-bid"
          value={String(summary.noBidCount)}
          sub={summary.noBidCount === 1 ? "deal we passed on" : "deals we passed on"}
        />
      </section>

      {summary.totalClosed === 0 ? (
        <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-8 text-center">
          <h2 className="text-base font-semibold text-ppp-charcoal mb-2">
            No debriefs in this period
          </h2>
          <p className="text-sm text-ppp-charcoal-500">
            Try a wider range, or head to the{" "}
            <Link href="/commercial/opportunities" className="text-cc-brand-700 underline">pipeline</Link> to close some deals.
          </p>
        </section>
      ) : (
        <>
          {/* Competitor leaderboard + Deciding factor — side-by-side on desktop, stacked on mobile */}
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6">
            <article className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
              <h2 className="text-base font-semibold text-ppp-charcoal mb-3">
                Who we lose to most
              </h2>
              {competitors.length === 0 ? (
                <p className="text-sm text-ppp-charcoal-500">No competitor data yet.</p>
              ) : (
                <ul className="space-y-2">
                  {competitors.map((c) => {
                    const pct = totalCompetitorMentions > 0
                      ? Math.round((c.total_count / totalCompetitorMentions) * 100)
                      : 0;
                    return (
                      <li key={c.competitor_id ?? "unknown"} className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-sm font-medium text-ppp-charcoal truncate">
                              {c.competitor_name}
                            </span>
                            <span className="text-[11px] text-ppp-charcoal-500 shrink-0">
                              {c.lost_count > 0 && (
                                <span className="text-rose-700 font-semibold">{c.lost_count} loss{c.lost_count === 1 ? "" : "es"}</span>
                              )}
                              {c.won_count > 0 && (
                                <span className="ml-2 text-emerald-700 font-semibold">{c.won_count} win{c.won_count === 1 ? "" : "s"}</span>
                              )}
                            </span>
                          </div>
                          <div className="mt-1 h-1.5 bg-ppp-charcoal-50 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-rose-500"
                              style={{ width: `${pct}%` }}
                              aria-label={`${pct}% of debriefs mention this competitor`}
                            />
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </article>

            <article className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
              <h2 className="text-base font-semibold text-ppp-charcoal mb-3">
                Why we lose
              </h2>
              {factors.length === 0 ? (
                <p className="text-sm text-ppp-charcoal-500">No deciding-factor data yet.</p>
              ) : (
                <ul className="space-y-2">
                  {factors.map((f) => {
                    const pct = totalFactorMentions > 0
                      ? Math.round((f.count / totalFactorMentions) * 100)
                      : 0;
                    const label = f.deciding_factor === "(unspecified)"
                      ? "(unspecified)"
                      : opportunityLossReasonLabel(f.deciding_factor as Parameters<typeof opportunityLossReasonLabel>[0]);
                    return (
                      <li key={f.deciding_factor} className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-sm font-medium text-ppp-charcoal">
                              {label}
                            </span>
                            <span className="text-[11px] text-ppp-charcoal-500 shrink-0">
                              {f.count} ({pct}%)
                            </span>
                          </div>
                          <div className="mt-1 h-1.5 bg-ppp-charcoal-50 rounded-full overflow-hidden">
                            <div className="h-full bg-amber-500" style={{ width: `${pct}%` }} aria-hidden />
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </article>
          </section>

          {/* Lessons learned feed */}
          <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 mb-6">
            <h2 className="text-base font-semibold text-ppp-charcoal mb-3">
              What we&apos;d do differently — recent
            </h2>
            {lessons.length === 0 ? (
              <p className="text-sm text-ppp-charcoal-500">
                No lessons captured yet in this period.
              </p>
            ) : (
              <ul className="space-y-3 divide-y divide-ppp-charcoal-50">
                {lessons.map((l) => (
                  <li key={l.debrief_id} className="pt-3 first:pt-0">
                    <div className="flex flex-wrap items-baseline gap-2 mb-1">
                      <Link
                        href={`/commercial/opportunities/${l.opportunity_id}`}
                        className="text-sm font-semibold text-cc-brand-700 hover:text-cc-brand-800 underline underline-offset-2"
                      >
                        {l.opportunity_title}
                      </Link>
                      <OutcomeChip outcome={l.outcome} />
                      {l.competitor_name && (
                        <span className="text-[12px] text-ppp-charcoal-500">
                          vs. <span className="font-medium text-ppp-charcoal">{l.competitor_name}</span>
                        </span>
                      )}
                      {l.deciding_factor && (
                        <span className="text-[11px] uppercase tracking-wider text-ppp-charcoal-400">
                          {opportunityLossReasonLabel(l.deciding_factor as Parameters<typeof opportunityLossReasonLabel>[0])}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-ppp-charcoal leading-relaxed">
                      &ldquo;{l.lessons_learned}&rdquo;
                    </p>
                    <div className="text-[11px] text-ppp-charcoal-400 mt-1">
                      {fmtEtDate(new Date(l.debriefed_at))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function KpiCard({
  tone,
  label,
  value,
  sub,
}: {
  tone: "cc-brand" | "blue" | "rose" | "neutral";
  label: string;
  value: string;
  sub: string;
}) {
  const ring =
    tone === "cc-brand"
      ? "border-cc-brand-200 bg-gradient-to-br from-white to-cc-brand-50/50"
      : tone === "blue"
      ? "border-cc-brand-200 bg-gradient-to-br from-white to-blue-50/50"
      : tone === "rose"
      ? "border-rose-200 bg-gradient-to-br from-white to-rose-50/50"
      : "border-ppp-charcoal-100 bg-white";
  const stripe =
    tone === "cc-brand"
      ? "bg-cc-brand-600"
      : tone === "blue"
      ? "bg-cc-brand-500"
      : tone === "rose"
      ? "bg-rose-500"
      : "bg-ppp-charcoal-200";
  const valueCls = tone === "rose" ? "text-rose-700" : "text-ppp-charcoal";
  return (
    <div className={`relative border rounded-xl px-4 py-3 overflow-hidden shadow-sm ${ring}`}>
      <span aria-hidden className={`absolute left-0 top-0 bottom-0 w-[3px] ${stripe}`} />
      <div className="text-[12px] font-semibold text-ppp-charcoal-700">
        {label}
      </div>
      <div className={`text-xl sm:text-2xl font-bold mt-1 ${valueCls}`}>
        {value}
      </div>
      <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">{sub}</div>
    </div>
  );
}

function OutcomeChip({ outcome }: { outcome: "won" | "lost" | "no_bid" }) {
  const cfg = {
    won: { bg: "bg-emerald-50", fg: "text-emerald-800", label: "Won" },
    lost: { bg: "bg-rose-50", fg: "text-rose-800", label: "Lost" },
    no_bid: { bg: "bg-ppp-charcoal-50", fg: "text-ppp-charcoal-700", label: "No bid" },
  }[outcome];
  return (
    <span className={`inline-flex items-center text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${cfg.bg} ${cfg.fg}`}>
      {cfg.label}
    </span>
  );
}
