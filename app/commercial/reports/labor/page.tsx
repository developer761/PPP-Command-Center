import { redirect } from "next/navigation";
import { requireReportAccess } from "@/lib/commercial/reports/access";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { normalizeRole } from "@/lib/auth/roles";
import { isAdminEmail } from "@/lib/auth/admin";
import { getLaborReport } from "@/lib/commercial/reports/labor";
import { formatCentsFull, formatCentsCompact } from "@/lib/commercial/invoices/format";
import { LABOR_PRESETS, LABOR_DEFAULT, laborRange, resolvePreset, type LaborPreset } from "@/lib/commercial/reports/presets";
import { ExportCsvLink } from "@/components/commercial/export-csv-link";

/**
 * Labor & payroll — the first report with a PERSON in it.
 *
 * Field Ops has held every hour since it shipped and no report read it, so
 * "where did the crew go last month" meant opening jobs one at a time.
 *
 * Karan 2026-08-12: per-person numbers are ADMIN ONLY. Everyone with report
 * access sees the totals, the weekly trend and the by-job table — those are
 * about the work. The named breakdown is about people, and it is scoped.
 */

export const dynamic = "force-dynamic";

type Preset = LaborPreset;

const PRESETS = LABOR_PRESETS;

/** Ranges as plain ET calendar strings — `work_date` is a DATE column, and
 *  every timezone bug on this platform started by treating one as an instant. */

const hrs = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 1 })}h`;

export default async function LaborReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");
  // Report folders: only reports in a folder you belong to (admins see all).
  await requireReportAccess(user.id, user.email, "labor");

  const role = normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(user.email));
  const canSeePeople = role === "admin" || role === "account_manager";

  const sp = await searchParams;
  const preset = resolvePreset(sp.preset, PRESETS, LABOR_DEFAULT);
  const range = laborRange(preset);
  const report = await getLaborReport(range);

  const peakWeekHours = Math.max(1, ...report.weeks.map((w) => w.hours));

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-8 space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-ppp-charcoal">Labor &amp; payroll</h2>
          <p className="text-[12px] text-ppp-charcoal-500 mt-0.5 max-w-xl">
            Approved crew hours, and what was paid out for them, across every job. Hours and money are
            two separate counts of the same work and are never added together &mdash; the hours come from
            Attendance, the money from what was actually paid to each crew.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {PRESETS.map((p) => (
          <Link
            key={p.key}
            href={`/commercial/reports/labor?preset=${p.key}`}
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
        {/* Export sits WITH the range control, not in the header: what you
            download is the window you have selected, and pairing them makes
            that obvious. */}
        <span className="ml-auto">
          {/* The labor CSV is per-person pay, so the route gates it to admin /
              account manager. This page does NOT redirect a rep (it just hides
              names), so without matching the gate here a rep would click Export
              and get a raw JSON 403. Disabled with a reason instead. */}
          <ExportCsvLink
            href="/api/commercial/reports/labor/export"
            preset={preset}
            disabled={!canSeePeople || (report.people.length === 0 && report.jobs.length === 0)}
            disabledHint={!canSeePeople ? "The labor export includes per-person pay — admins and account managers only" : "Nothing to export yet"}
          />
        </span>
      </div>

      {report.totalHours === 0 && report.payoutCents === 0 ? (
        // The empty state used to say "No W-2 payroll hours in this period",
        // and it said it EVERY time, because every one of Tomco's 23 crew is a
        // subcontractor and the report was W-2-only. It explained the trap
        // instead of being fixed — a page sitting next to 14,992 approved
        // hours and $555,789.53 of payouts, telling you there was nothing here.
        // Now it only appears when the period is genuinely quiet.
        <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-8 text-center">
          <p className="text-[13px] font-semibold text-ppp-charcoal">No crew hours or payouts in this period.</p>
          <p className="text-[12px] text-ppp-charcoal-500 mt-1 max-w-lg mx-auto">
            Nothing was worked or paid out between those dates. Try a wider range, or check the approvals queue if
            hours have been logged but not yet approved.
          </p>
          <div className="flex items-center justify-center gap-4 flex-wrap mt-3">
            <Link href="/commercial/reports/attendance" className="inline-flex items-center text-[12px] font-semibold text-cc-brand-700 hover:underline min-h-[44px]">
              See the hours on Attendance →
            </Link>
            <Link href="/commercial/field-ops/approvals" className="inline-flex items-center text-[12px] font-semibold text-ppp-charcoal-500 hover:underline min-h-[44px]">
              Approvals queue
            </Link>
          </div>
        </div>
      ) : (
        <>
          {/* "Labor cost" used to be the rate-priced W-2 figure, which for
              Tomco is $0 of a $555,789.53 reality. Paid out to crews is the
              money that actually left, so it leads; the payroll card appears
              only if there is payroll. The two are never added. */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Kpi label="Crew hours" value={hrs(report.totalHours)} />
            <Kpi label="Paid out to crews" value={formatCentsFull(report.payoutCents)} tone="brand" />
            {report.totalCostCents > 0 ? (
              <Kpi label="Payroll cost (W-2)" value={formatCentsFull(report.totalCostCents)} />
            ) : (
              <Kpi label="Jobs worked" value={String(report.jobs.length)} />
            )}
            <Kpi
              label="Avg $/hour paid"
              value={
                report.totalHours > 0 && report.payoutCents > 0
                  ? formatCentsFull(Math.round(report.payoutCents / report.totalHours))
                  : "—"
              }
            />
          </div>

          {/* WHO WAS PAID. The thing Katie came here for and could not find:
              "the Labor payouts from Salesforce aren't showing up in Command
              Center." They were in the book the whole time; no report read
              them. */}
          {report.payouts.length > 0 && (
            <section className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-ppp-charcoal-100">
                <h3 className="text-[13px] font-bold text-ppp-charcoal">Paid out to crews</h3>
                <p className="text-[11.5px] text-ppp-charcoal-500 mt-0.5">
                  What each crew or labor company was paid in this period. This is the labor money that left the
                  business &mdash; the hours above are a separate count of the same work.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-ppp-charcoal-400 border-b border-ppp-charcoal-100">
                      <th className="px-4 py-2 font-semibold">Crew</th>
                      <th className="px-4 py-2 font-semibold text-right">Paid</th>
                      <th className="px-4 py-2 font-semibold text-right">Payments</th>
                      <th className="px-4 py-2 font-semibold text-right">Jobs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.payouts.map((p) => (
                      <tr key={p.vendor} className="border-b border-ppp-charcoal-50 last:border-0">
                        <td className="px-4 py-2.5 font-semibold text-ppp-charcoal">{p.vendor}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-ppp-charcoal">
                          {formatCentsFull(p.amountCents)}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-ppp-charcoal-500">{p.count}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-ppp-charcoal-500">{p.jobCount}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-ppp-charcoal-200">
                      <td className="px-4 py-2.5 font-bold text-ppp-charcoal">Total</td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-bold text-ppp-charcoal">
                        {formatCentsFull(report.payoutCents)}
                      </td>
                      <td colSpan={2} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
          )}

          {/* The honesty line. An unpriced hour makes the cost column an
              UNDERSTATEMENT, and a payroll figure that is quietly low is one
              people plan against. Names it and says whose rate to set. */}
          {report.unratedHours > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3">
              <p className="text-[12.5px] font-semibold text-amber-900">
                {hrs(report.unratedHours)} worked are not costed yet — the labor cost above is short by
                whatever those hours were worth until the week is posted in Payroll.
              </p>
              <p className="text-[11.5px] text-amber-800 mt-0.5">
                {canSeePeople ? report.unratedPeople.join(", ") : `${report.unratedPeople.length} ${report.unratedPeople.length === 1 ? "person" : "people"}`}
                {" · "}
                <Link href="/commercial/field-ops/employees" className="font-semibold underline hover:text-amber-950">
                  Set rates
                </Link>
              </p>
            </div>
          )}

          {/* Weekly trend — the shape of a season, and the fastest way to see
              a week nobody logged. */}
          {report.weeks.length > 1 && (
            <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4">
              <h3 className="text-[13px] font-bold text-ppp-charcoal mb-3">Hours by week</h3>
              <div className="flex items-end gap-1.5 h-28 overflow-x-auto">
                {report.weeks.map((w) => (
                  <div key={w.weekStart} className="flex flex-col items-center gap-1 min-w-[34px] flex-1">
                    <div
                      className="w-full rounded-t bg-cc-brand-500/80 min-h-[2px]"
                      style={{ height: `${Math.round((w.hours / peakWeekHours) * 88)}px` }}
                      title={
                        w.costCents > 0
                          ? `Week of ${w.weekStart} · ${hrs(w.hours)} · ${formatCentsCompact(w.costCents)}`
                          : `Week of ${w.weekStart} · ${hrs(w.hours)}`
                      }
                    />
                    <span className="text-[9px] text-ppp-charcoal-400 tabular-nums whitespace-nowrap">
                      {w.weekStart.slice(5)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {canSeePeople && (
            <Table
              title="By person"
              hint={
                report.totalCostCents > 0
                  ? "Costliest first. Hours, what they cost, and how many jobs they touched."
                  : "Most hours first. Everyone here is paid through a labor company, so their money is in Paid out to crews above, not against their name."
              }
              // A "Cost" column reading $0.00 against all 22 crew is worse than
              // no column — it looks like data that failed to load. Payroll cost
              // is shown only where there IS payroll.
              head={report.totalCostCents > 0 ? ["Person", "Jobs", "Hours", "Payroll cost"] : ["Person", "Jobs", "Hours"]}
              rows={report.people.map((p) =>
                report.totalCostCents > 0
                  ? [
                      p.name + (p.unratedHours > 0 ? ` · ${hrs(p.unratedHours)} unpriced` : ""),
                      String(p.jobCount),
                      hrs(p.hours),
                      p.isSub ? "via crew payout" : formatCentsFull(p.costCents),
                    ]
                  : [p.name, String(p.jobCount), hrs(p.hours)]
              )}
            />
          )}

          <Table
            title="By job"
            hint="Where the hours went and what was paid against each job. Click through to the deal for the rest of its costs."
            head={["Job", "Crew", "Hours", "Paid out"]}
            rows={report.jobs.map((j) => [
              j.jobName + (j.unratedHours > 0 ? ` · ${hrs(j.unratedHours)} unpriced` : ""),
              String(j.crewCount),
              hrs(j.hours),
              formatCentsFull(j.payoutCents),
            ])}
            hrefs={report.jobs.map((j) => (j.opportunityId ? `/commercial/opportunities/${j.opportunityId}?tab=costs` : null))}
          />
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: "brand" }) {
  return (
    <div className="bg-surface border border-ppp-charcoal-100 rounded-xl px-3.5 py-3">
      <div className="text-[9.5px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
      <div className={`font-condensed text-[20px] font-black tabular-nums leading-tight mt-0.5 ${tone === "brand" ? "text-cc-brand-700" : "text-ppp-charcoal"}`}>
        {value}
      </div>
    </div>
  );
}

function Table({
  title,
  hint,
  head,
  rows,
  hrefs,
}: {
  title: string;
  hint: string;
  head: string[];
  rows: string[][];
  hrefs?: (string | null)[];
}) {
  if (rows.length === 0) return null;
  return (
    <div className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-ppp-charcoal-100">
        <h3 className="text-[13px] font-bold text-ppp-charcoal">{title}</h3>
        <p className="text-[11.5px] text-ppp-charcoal-500 mt-0.5">{hint}</p>
      </div>
      {/* Scrolls inside itself so the page never slides sideways on a phone. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-[12.5px]">
          <thead>
            <tr className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500 bg-ppp-charcoal-50/60">
              {head.map((h, i) => (
                <th key={h} className={`px-4 py-2 ${i === 0 ? "text-left" : "text-right"}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-ppp-charcoal-100">
            {rows.map((r, i) => {
              const href = hrefs?.[i] ?? null;
              return (
                <tr key={`${r[0]}-${i}`} className="hover:bg-ppp-charcoal-50/60">
                  {r.map((cell, j) => (
                    <td key={j} className={`px-4 py-2.5 ${j === 0 ? "text-left font-semibold text-ppp-charcoal" : "text-right tabular-nums text-ppp-charcoal-700"}`}>
                      {j === 0 && href ? (
                        <Link href={href} className="hover:text-cc-brand-700 hover:underline">{cell}</Link>
                      ) : (
                        cell
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
