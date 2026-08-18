import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { normalizeRole } from "@/lib/auth/roles";
import { isAdminEmail } from "@/lib/auth/admin";
import { getEstimatorReport } from "@/lib/commercial/reports/estimator";
import { formatCentsFull, formatCentsCompact } from "@/lib/commercial/invoices/format";
import { etTodayIso } from "@/lib/date-et";

/**
 * Estimator / proposal performance — "how is Kim doing".
 *
 * Per-person performance, so Admin / Account Manager only. A rep landing here
 * is redirected rather than shown an empty shell: a page that exists but
 * refuses is worse than one that isn't in your nav.
 *
 * The table IS the report. No hero chart above it — the question is "who sent
 * what and how much came back", and that is a table. What sits above is only
 * the four numbers you would otherwise add up by hand.
 */

export const dynamic = "force-dynamic";

type Preset = "this_month" | "last_month" | "last_90" | "this_year" | "last_year";

const PRESETS: { key: Preset; label: string }[] = [
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "last_90", label: "Last 90 days" },
  { key: "this_year", label: "This year" },
  { key: "last_year", label: "Last year" },
];

/**
 * Plain ET calendar strings throughout — the dates being compared are DATE
 * columns, and every timezone bug on this platform began by treating one as an
 * instant.
 *
 * Calendar year, matching Karan's answer that Tomco's fiscal year starts in
 * January. If that ever changes, `fiscal_year_start_month` in
 * `commercial_settings` is where it belongs — and it is wired below.
 */
function rangeFor(preset: Preset, fyStartMonth: number): { fromYmd: string; toYmd: string; label: string } {
  const today = etTodayIso();
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const pad = (n: number) => String(n).padStart(2, "0");
  const lastDay = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  /** The year label a date belongs to under the configured FY start. */
  const fyStart = (yy: number) => `${yy}-${pad(fyStartMonth)}-01`;
  const currentFyYear = m >= fyStartMonth ? y : y - 1;

  switch (preset) {
    case "last_month": {
      const ly = m === 1 ? y - 1 : y;
      const lm = m === 1 ? 12 : m - 1;
      return { fromYmd: `${ly}-${pad(lm)}-01`, toYmd: `${ly}-${pad(lm)}-${pad(lastDay(ly, lm))}`, label: "Last month" };
    }
    case "last_90": {
      const d = new Date(Date.UTC(y, m - 1, Number(today.slice(8, 10))));
      d.setUTCDate(d.getUTCDate() - 89);
      return { fromYmd: d.toISOString().slice(0, 10), toYmd: today, label: "Last 90 days" };
    }
    case "this_year":
      return { fromYmd: fyStart(currentFyYear), toYmd: today, label: fyStartMonth === 1 ? `${currentFyYear}` : `FY${currentFyYear}` };
    case "last_year": {
      const py = currentFyYear - 1;
      const end = new Date(Date.UTC(currentFyYear, fyStartMonth - 1, 1));
      end.setUTCDate(end.getUTCDate() - 1);
      return { fromYmd: fyStart(py), toYmd: end.toISOString().slice(0, 10), label: fyStartMonth === 1 ? `${py}` : `FY${py}` };
    }
    case "this_month":
    default:
      return { fromYmd: `${y}-${pad(m)}-01`, toYmd: today, label: "This month" };
  }
}

export default async function EstimatorReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");

  const role = normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(user.email));
  if (role !== "admin" && role !== "account_manager") redirect("/commercial/reports");

  const sp = await searchParams;
  const raw = Array.isArray(sp.preset) ? sp.preset[0] : sp.preset;
  const preset: Preset = PRESETS.some((p) => p.key === raw) ? (raw as Preset) : "this_year";

  // `fiscal_year_start_month` was seeded in commercial_settings and read by
  // NOTHING — a knob that looked live and did nothing, the same shape as
  // project_id. Wired here so setting it actually moves the year boundaries.
  const { getCommercialSetting } = await import("@/lib/commercial/settings");
  const fyRaw = await getCommercialSetting<number>("fiscal_year_start_month", 1);
  // Clamped, because a bad value here silently shifts every year boundary on
  // the report rather than erroring.
  const fyStartMonth = Number.isFinite(Number(fyRaw))
    ? Math.min(12, Math.max(1, Math.round(Number(fyRaw))))
    : 1;

  const range = rangeFor(preset, fyStartMonth);
  const report = await getEstimatorReport(range);
  const t = report.totals;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-8 space-y-4">
      <div>
        <h2 className="text-lg font-bold text-ppp-charcoal">Estimator performance</h2>
        <p className="text-[12px] text-ppp-charcoal-500 mt-0.5 max-w-2xl">
          One row per person, one bid per deal — a revised proposal is still one bid. Bids are counted
          in the period they <strong>went out</strong>, and the win rate counts only bids that have been
          decided, so an open bid never reads as a loss.
        </p>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {PRESETS.map((p) => (
          <Link
            key={p.key}
            href={`/commercial/reports/estimator?preset=${p.key}`}
            aria-current={p.key === preset ? "page" : undefined}
            className={`inline-flex items-center px-3 rounded-lg text-[12px] font-semibold min-h-[44px] sm:min-h-[34px] border transition-colors ${
              p.key === preset
                ? "bg-cc-brand-600 text-white border-cc-brand-600"
                : "bg-surface text-ppp-charcoal-600 border-ppp-charcoal-200 hover:bg-ppp-charcoal-50"
            }`}
          >
            {p.label}
          </Link>
        ))}
      </div>

      {t.bidsSent === 0 ? (
        <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-8 text-center">
          <p className="text-[13px] font-semibold text-ppp-charcoal">No bids went out in {range.label.toLowerCase()}.</p>
          <p className="text-[12px] text-ppp-charcoal-500 mt-1 max-w-md mx-auto">
            A bid counts once its proposal has been sent to the GC — a draft sitting on a deal isn&rsquo;t a
            bid yet.
          </p>
          <Link href="/commercial/opportunities" className="inline-flex items-center mt-3 text-[12px] font-semibold text-cc-brand-700 hover:underline min-h-[44px]">
            Go to the pipeline →
          </Link>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Kpi label="Bids sent" value={String(t.bidsSent)} sub={formatCentsCompact(t.bidValueCents)} />
            <Kpi
              label="Win rate"
              value={t.winRatePct === null ? "—" : `${t.winRatePct}%`}
              sub={t.winRatePct === null ? "nothing decided yet" : `${t.won} won · ${t.lost} lost`}
              tone={t.winRatePct === null ? undefined : t.winRatePct >= 50 ? "good" : t.winRatePct < 25 ? "bad" : undefined}
            />
            <Kpi label="Won" value={formatCentsCompact(t.wonValueCents)} sub={`${t.open} still out`} tone="good" />
            <Kpi
              label="Avg turnaround"
              value={t.avgTurnaroundDays === null ? "—" : `${t.avgTurnaroundDays}d`}
              sub={t.avgTurnaroundDays === null ? "no RFP dates on file" : `over ${t.turnaroundSample} bid${t.turnaroundSample === 1 ? "" : "s"}`}
            />
          </div>

          {/* What the numbers can't see. Stated rather than left for someone to
              discover when a figure looks wrong. */}
          {(report.missingRfpDate > 0 || report.sentBeforeRfp > 0) && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-[12px] text-amber-900 space-y-0.5">
              {report.missingRfpDate > 0 && (
                <p>
                  <strong className="font-semibold">{report.missingRfpDate}</strong> bid
                  {report.missingRfpDate === 1 ? " has" : "s have"} no RFP-received date, so turnaround
                  can&rsquo;t be measured on {report.missingRfpDate === 1 ? "it" : "them"}. They still count
                  everywhere else.
                </p>
              )}
              {report.sentBeforeRfp > 0 && (
                <p>
                  <strong className="font-semibold">{report.sentBeforeRfp}</strong> bid
                  {report.sentBeforeRfp === 1 ? " was" : "s were"} sent before the RFP-received date —
                  a typo rather than a fast bid, so {report.sentBeforeRfp === 1 ? "it is" : "they are"} left
                  out of the average.
                </p>
              )}
            </div>
          )}

          <div className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-ppp-charcoal-100">
              <h3 className="text-[13px] font-bold text-ppp-charcoal">By estimator · {range.label}</h3>
              <p className="text-[11.5px] text-ppp-charcoal-500 mt-0.5">
                Most bids first. Click a name to see their deals in the pipeline.
              </p>
            </div>
            {/* Scrolls inside itself so the page never slides sideways. */}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-[12.5px]">
                <thead>
                  <tr className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500 bg-ppp-charcoal-50/60">
                    <th className="px-4 py-2 text-left">Estimator</th>
                    <th className="px-4 py-2 text-right">Bids</th>
                    <th className="px-4 py-2 text-right">Value</th>
                    <th className="px-4 py-2 text-right">Win rate</th>
                    <th className="px-4 py-2 text-right">Won</th>
                    <th className="px-4 py-2 text-right">Turnaround</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ppp-charcoal-100">
                  {/* Header-with-no-rows reads as a bug. Say what's missing. */}
                  {report.rows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-6 text-center text-[12px] text-ppp-charcoal-500">
                        No bids in this period yet &mdash; estimator numbers appear once opportunities are assigned and decided.
                      </td>
                    </tr>
                  )}
                  {report.rows.map((r) => {
                    const decided = r.won + r.lost;
                    // A 100% rate off one decided bid is noise, and printing it
                    // bare invites someone to quote it in a meeting.
                    const thin = decided > 0 && decided < 3;
                    return (
                      <tr key={r.key} className="hover:bg-ppp-charcoal-50/60">
                        <td className="px-4 py-2.5 text-left font-semibold text-ppp-charcoal">
                          {r.key === "__unassigned__" ? (
                            <span className="text-amber-800">
                              Unassigned
                              <span className="block text-[10.5px] font-normal text-amber-700">
                                No estimator on the deal
                              </span>
                            </span>
                          ) : (
                            <Link
                              href={`/commercial/opportunities?estimator=${encodeURIComponent(r.key)}`}
                              className="hover:text-cc-brand-700 hover:underline"
                            >
                              {r.name}
                            </Link>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-ppp-charcoal-700">{r.bidsSent}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-ppp-charcoal-700">{formatCentsCompact(r.bidValueCents)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          {r.winRatePct === null ? (
                            <span className="text-ppp-charcoal-400">— <span className="text-[10.5px]">undecided</span></span>
                          ) : (
                            <>
                              <span className={r.winRatePct >= 50 ? "text-emerald-700 font-semibold" : r.winRatePct < 25 ? "text-rose-700 font-semibold" : "text-ppp-charcoal-700"}>
                                {r.winRatePct}%
                              </span>
                              {thin && <span className="ml-1 text-[10px] text-ppp-charcoal-400">of {decided}</span>}
                            </>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-ppp-charcoal-700">{formatCentsCompact(r.wonValueCents)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-ppp-charcoal-700">
                          {r.avgTurnaroundDays === null ? <span className="text-ppp-charcoal-400">—</span> : `${r.avgTurnaroundDays}d`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-ppp-charcoal-50/60 text-[12px] font-bold text-ppp-charcoal">
                    <td className="px-4 py-2.5 text-left">Everyone</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{t.bidsSent}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{formatCentsCompact(t.bidValueCents)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{t.winRatePct === null ? "—" : `${t.winRatePct}%`}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{formatCentsFull(t.wonValueCents)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{t.avgTurnaroundDays === null ? "—" : `${t.avgTurnaroundDays}d`}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  return (
    <div className="bg-surface border border-ppp-charcoal-100 rounded-xl px-3.5 py-3">
      <div className="text-[9.5px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
      <div
        className={`font-condensed text-[20px] font-black tabular-nums leading-tight mt-0.5 ${
          tone === "good" ? "text-emerald-700" : tone === "bad" ? "text-rose-700" : "text-ppp-charcoal"
        }`}
      >
        {value}
      </div>
      {sub && <div className="text-[10.5px] text-ppp-charcoal-500 mt-0.5 tabular-nums">{sub}</div>}
    </div>
  );
}
