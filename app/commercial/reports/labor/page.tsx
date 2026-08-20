import { redirect } from "next/navigation";
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
 * Labour & payroll — the first report with a PERSON in it.
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
          <h2 className="text-lg font-bold text-ppp-charcoal">Labour &amp; payroll</h2>
          <p className="text-[12px] text-ppp-charcoal-500 mt-0.5 max-w-xl">
            Approved crew hours and what they cost, across every job. In-house (W-2) time only —
            subs are logged as Subcontract labour on a job&rsquo;s costs, so counting them here would
            double them. Rates are effective-dated, so a raise doesn&rsquo;t restate an older job.
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
          {/* The labour CSV is per-person pay, so the route gates it to admin /
              account manager. This page does NOT redirect a rep (it just hides
              names), so without matching the gate here a rep would click Export
              and get a raw JSON 403. Disabled with a reason instead. */}
          <ExportCsvLink
            href="/api/commercial/reports/labor/export"
            preset={preset}
            disabled={!canSeePeople || (report.people.length === 0 && report.jobs.length === 0)}
            disabledHint={!canSeePeople ? "The labour export includes per-person pay — admins and account managers only" : "Nothing to export yet"}
          />
        </span>
      </div>

      {report.totalHours === 0 ? (
        <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-8 text-center">
          <p className="text-[13px] font-semibold text-ppp-charcoal">No approved hours in this period.</p>
          <p className="text-[12px] text-ppp-charcoal-500 mt-1 max-w-md mx-auto">
            Hours appear here once a foreman submits them and they&rsquo;re approved — a submitted or
            questioned entry isn&rsquo;t a settled cost yet.
          </p>
          <Link href="/commercial/field-ops/approvals" className="inline-flex items-center mt-3 text-[12px] font-semibold text-cc-brand-700 hover:underline min-h-[44px]">
            Go to approvals →
          </Link>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Kpi label="Crew hours" value={hrs(report.totalHours)} />
            <Kpi label="Labour cost" value={formatCentsFull(report.totalCostCents)} tone="brand" />
            <Kpi label="Jobs worked" value={String(report.jobs.length)} />
            <Kpi
              label="Avg $/hour"
              value={
                report.totalHours > 0
                  ? formatCentsFull(Math.round(report.totalCostCents / report.totalHours))
                  : "—"
              }
            />
          </div>

          {/* The honesty line. An unpriced hour makes the cost column an
              UNDERSTATEMENT, and a payroll figure that is quietly low is one
              people plan against. Names it and says whose rate to set. */}
          {report.unratedHours > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3">
              <p className="text-[12.5px] font-semibold text-amber-900">
                {hrs(report.unratedHours)} worked with no cost rate on file — the labour cost above is short by
                whatever those hours were worth.
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
                      title={`Week of ${w.weekStart} · ${hrs(w.hours)} · ${formatCentsCompact(w.costCents)}`}
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
              hint="Costliest first. Hours, what they cost, and how many jobs they touched."
              head={["Person", "Jobs", "Hours", "Cost"]}
              rows={report.people.map((p) => [
                p.name + (p.unratedHours > 0 ? ` · ${hrs(p.unratedHours)} unpriced` : ""),
                String(p.jobCount),
                hrs(p.hours),
                formatCentsFull(p.costCents),
              ])}
            />
          )}

          <Table
            title="By job"
            hint="Where the hours went. Click through to the deal for the rest of its costs."
            head={["Job", "Crew", "Hours", "Cost"]}
            rows={report.jobs.map((j) => [
              j.jobName + (j.unratedHours > 0 ? ` · ${hrs(j.unratedHours)} unpriced` : ""),
              String(j.crewCount),
              hrs(j.hours),
              formatCentsFull(j.costCents),
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
