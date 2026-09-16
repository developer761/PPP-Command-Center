import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { requireReportAccess } from "@/lib/commercial/reports/access";
import { getJobsOverviewRows } from "@/lib/commercial/reports/jobs";
import {
  JOB_GROUPS,
  JOB_SORTS,
  defaultDirFor,
  filterJobRows,
  gcOptions,
  resolveGroupFilter,
  resolveSort,
  sortJobRows,
  summarizeJobRows,
  type JobsReportRow,
  type JobSortKey,
  type SortDir,
} from "@/lib/commercial/reports/jobs-rows";
import { ACTIVITY_PRESETS, ACTIVITY_DEFAULT, activityRange, resolvePreset } from "@/lib/commercial/reports/presets";
import { formatCentsCompact, formatCentsFull, fmtEtDate } from "@/lib/commercial/invoices/format";
import { statusPillTone } from "@/lib/commercial/opportunities/status-tone";
import { oppStatusDisplayLabel } from "@/lib/commercial/opportunities/kanban-columns";
import { ExportCsvLink } from "@/components/commercial/export-csv-link";
import { SearchableSelect } from "@/components/commercial/searchable-select";
import { INPUT_CLS, SELECT_CLS, SELECT_BG_STYLE } from "@/lib/commercial/form-classnames";

export const dynamic = "force-dynamic";

/**
 * JOBS — the overview of every job, and the way into one job's own report.
 *
 * Karan, 2026-09-15: *"we go on the reports tab and then we choose a job and
 * have reports for that job only. We should have an overview page for all the
 * jobs, plus like an all jobs in reports that has reports for all jobs combined
 * or in a certain period."*
 *
 * So this page is BOTH halves of that: the combined totals across whatever you
 * have filtered to sit at the top, and every job that went into them is listed
 * underneath, each a door into its own report.
 *
 * The period narrows by the JOB'S date (won/lost, else created), not by when
 * money moved — and the caption under the totals says so out loud, because
 * "$400k billed · this month" would otherwise read as this month's billing when
 * it is the life-to-date billing of jobs that started this month. Money that
 * moved IN a window is what Cash flow answers; this is a job book.
 *
 * Sorting and filtering are plain links + one GET form, so the whole page works
 * with no client JavaScript and every control is a real 44px target on a phone.
 */

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export default async function JobsReportPage({ searchParams }: { searchParams: Promise<SP> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");
  // Report folders: only reports in a folder you belong to (admins see all).
  await requireReportAccess(user.id, user.email, "jobs");

  const sp = await searchParams;
  const q = (one(sp.q) ?? "").slice(0, 120);
  const group = resolveGroupFilter(sp.group);
  const gc = one(sp.gc) ?? "all";
  const preset = resolvePreset(sp.preset, ACTIVITY_PRESETS, ACTIVITY_DEFAULT);
  const range = activityRange(preset);
  const { key: sortKey, dir } = resolveSort(sp.sort, sp.dir);

  let rows: JobsReportRow[] = [];
  let loadError: string | null = null;
  try {
    rows = await getJobsOverviewRows();
  } catch (err) {
    console.error("[reports/jobs] load failed:", err);
    loadError = err instanceof Error ? err.message : "unknown error";
  }

  const gcs = gcOptions(rows);
  const filtered = filterJobRows(rows, { q, group, gc, fromYmd: range?.fromYmd ?? null, toYmd: range?.toYmd ?? null });
  const shown = sortJobRows(filtered, sortKey, dir);
  const totals = summarizeJobRows(filtered);
  // Group counts are computed WITHOUT the group filter, so the pills always say
  // how many you'd get by clicking them rather than "0" for every one you're not
  // currently on.
  const groupCounts = summarizeJobRows(
    filterJobRows(rows, { q, group: "all", gc, fromYmd: range?.fromYmd ?? null, toYmd: range?.toYmd ?? null })
  ).byGroup;
  const unfilteredCount = rows.length;
  const isFiltered = q !== "" || group !== "all" || gc !== "all" || preset !== ACTIVITY_DEFAULT;

  const base = "/commercial/reports/jobs";
  const qs = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged: Record<string, string | undefined> = {
      q: q || undefined,
      group: group === "all" ? undefined : group,
      gc: gc === "all" ? undefined : gc,
      preset: preset === ACTIVITY_DEFAULT ? undefined : preset,
      sort: sortKey === "contract" ? undefined : sortKey,
      dir: dir === defaultDirFor(sortKey) ? undefined : dir,
      ...over,
    };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };

  const exportParams = {
    q: q || undefined,
    group: group === "all" ? undefined : group,
    gc: gc === "all" ? undefined : gc,
    sort: sortKey,
    dir,
  };

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-8 space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-ppp-charcoal">Jobs</h2>
          <p className="mt-0.5 max-w-2xl text-[12px] text-ppp-charcoal-500">
            Every job, and the combined numbers for whatever you filter to. Open any job for its own full report.
          </p>
        </div>
        <ExportCsvLink
          href="/api/commercial/reports/jobs/export"
          preset={preset}
          params={exportParams}
          disabled={shown.length === 0}
          disabledHint="No jobs match these filters"
        />
      </div>

      {loadError && (
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] leading-snug text-amber-900">
          Couldn&rsquo;t load jobs just now ({loadError}). Nothing is shown rather than a wrong number — refresh to try again.
        </div>
      )}

      {/* ── Filters ── */}
      {unfilteredCount > 0 && (
        <div className="space-y-2.5 rounded-xl border border-ppp-charcoal-100 bg-surface p-3 sm:p-4">
          <FilterRow label="Status">
            <Pill href={qs({ group: undefined })} active={group === "all"}>
              All <Count n={unfilteredCountIn(groupCounts)} />
            </Pill>
            {JOB_GROUPS.map((g) => (
              <Pill key={g.key} href={qs({ group: g.key })} active={group === g.key} title={g.blurb}>
                {g.label} <Count n={groupCounts[g.key]} />
              </Pill>
            ))}
          </FilterRow>

          <FilterRow label="Period" hint="By job date — the day it was won or lost, or the day it was created if it&rsquo;s still open.">
            {ACTIVITY_PRESETS.map((p) => (
              <Pill key={p.key} href={qs({ preset: p.key === ACTIVITY_DEFAULT ? undefined : p.key })} active={preset === p.key}>
                {p.label}
              </Pill>
            ))}
          </FilterRow>

          <form method="get" action={base} className="flex flex-wrap items-end gap-2 pt-0.5">
            {group !== "all" && <input type="hidden" name="group" value={group} />}
            {preset !== ACTIVITY_DEFAULT && <input type="hidden" name="preset" value={preset} />}
            {sortKey !== "contract" && <input type="hidden" name="sort" value={sortKey} />}
            {dir !== defaultDirFor(sortKey) && <input type="hidden" name="dir" value={dir} />}

            <div className="min-w-0 flex-1 basis-[13rem]">
              <label htmlFor="jobs-q" className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">
                Search
              </label>
              <input
                id="jobs-q"
                name="q"
                type="search"
                defaultValue={q}
                placeholder="Job, GC, project number, address…"
                className={INPUT_CLS}
              />
            </div>

            <div className="min-w-0 flex-1 basis-[13rem]">
              <label htmlFor="jobs-gc" className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">
                GC
              </label>
              {gcs.length > 10 ? (
                <SearchableSelect
                  id="jobs-gc"
                  name="gc"
                  defaultValue={gc === "all" ? "" : gc}
                  ariaLabel="Filter by GC"
                  placeholder="Every GC"
                  options={gcs.map((g) => ({ value: g.id, label: g.name, hint: `${g.count} ${g.count === 1 ? "job" : "jobs"}` }))}
                />
              ) : (
                // The shared styled contract — `appearance-none` plus our own
                // chevron. A hand-rolled border around a bare select is how the
                // OS's grey dropdown keeps reappearing on new filter bars.
                <select id="jobs-gc" name="gc" defaultValue={gc} className={SELECT_CLS} style={SELECT_BG_STYLE}>
                  <option value="all">Every GC</option>
                  {gcs.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name} ({g.count})
                    </option>
                  ))}
                </select>
              )}
            </div>

            <button
              type="submit"
              className="min-h-[44px] shrink-0 rounded-lg bg-cc-brand-600 px-4 text-[13px] font-semibold text-white hover:bg-cc-brand-700 touch-manipulation"
            >
              Apply
            </button>
            {isFiltered && (
              <Link
                href={base}
                className="inline-flex min-h-[44px] shrink-0 items-center rounded-lg border border-ppp-charcoal-200 bg-surface px-3 text-[13px] font-semibold text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 touch-manipulation"
              >
                Clear
              </Link>
            )}
          </form>
        </div>
      )}

      {/* ── Combined totals ── */}
      {shown.length > 0 && (
        <section className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="flex items-center gap-2 text-[13px] font-bold text-ppp-charcoal">
              <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
              {totals.jobCount === unfilteredCount ? "All jobs combined" : "These jobs combined"}
            </h3>
            <p className="text-[11.5px] text-ppp-charcoal-500">
              {totals.jobCount} {totals.jobCount === 1 ? "job" : "jobs"} · {totals.gcCount} {totals.gcCount === 1 ? "GC" : "GCs"}
              {range ? ` · ${range.label.toLowerCase()}` : ""}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <Tile label="Contract" value={totals.contractCents > 0 ? formatCentsCompact(totals.contractCents) : "Not set"}
              sub={totals.withContract < totals.jobCount ? `${totals.jobCount - totals.withContract} with no contract yet` : undefined} />
            <Tile label="Billed" value={totals.billedCents > 0 ? formatCentsCompact(totals.billedCents) : "Nothing billed yet"} />
            <Tile label="Collected" value={totals.collectedCents > 0 ? formatCentsCompact(totals.collectedCents) : totals.billedCents > 0 ? "Nothing in yet" : "—"} tone="emerald" />
            <Tile label="Open balance" value={totals.openBalanceCents > 0 ? formatCentsCompact(totals.openBalanceCents) : totals.billedCents > 0 ? "All paid" : "—"} tone={totals.openBalanceCents > 0 ? "amber" : "neutral"}
              sub={totals.retainageHeldCents > 0 ? `+ ${formatCentsCompact(totals.retainageHeldCents)} retainage held` : undefined} />
            <Tile label="Cost" value={totals.costCents > 0 ? formatCentsCompact(totals.costCents) : "None logged"} tone="amber" />
            <Tile
              label={totals.marginLabel}
              value={totals.marginPct === null ? "—" : `${totals.marginPct}%`}
              sub={totals.marginCaveat ?? formatCentsFull(totals.marginCents)}
              tone={totals.marginPct === null || totals.marginCaveat ? "neutral" : totals.marginPct < 0 ? "rose" : totals.marginPct < 15 ? "amber" : "emerald"}
            />
            <Tile
              label="Labor hours"
              value={totals.laborHours > 0 ? `${fmtHours(totals.laborHours)}h` : "None logged"}
              sub={totals.unratedHours > 0 ? `${fmtHours(totals.unratedHours)}h with no cost rate` : undefined}
              tone={totals.unratedHours > 0 ? "amber" : "navy"}
            />
            <Tile label="In delivery" value={String(totals.byGroup.delivery)} sub={`${totals.byGroup.open} open · ${totals.byGroup.closed} closed`} tone="navy" />
          </div>

          <p className="text-[11px] leading-snug text-ppp-charcoal-500">
            Totals are each job&rsquo;s figures for its whole life, added up{range ? " over the jobs in this period" : ""} — not money that moved{range ? " during it" : ""}.
            For money in a window, use <Link href="/commercial/reports/cash-flow" className="font-semibold text-cc-brand-700 hover:underline">Cash flow</Link>.
            {totals.unratedHours > 0 && " Margin is understated while crew hours have no cost rate."}
          </p>
        </section>
      )}

      {/* ── The jobs ── */}
      {unfilteredCount === 0 ? (
        <EmptyBox
          title={loadError ? "Jobs couldn't be loaded" : "No jobs yet"}
          body={
            loadError
              ? "Refresh to try again. Nothing is shown rather than a number that might be wrong."
              : "Once a deal exists in Opportunities it shows here, whether or not it has been won. Every job then gets its own report."
          }
          cta={loadError ? null : { href: "/commercial/opportunities", label: "Go to Opportunities" }}
        />
      ) : shown.length === 0 ? (
        <EmptyBox
          title="No jobs match these filters"
          body={`There ${unfilteredCount === 1 ? "is 1 job" : `are ${unfilteredCount} jobs`} in total. Try a wider period, another status, or a different search.`}
          cta={{ href: base, label: "Clear filters" }}
        />
      ) : (
        <>
          {/* Phone: cards. An eleven-column table is unreadable at 400px. */}
          <ul className="space-y-2 sm:hidden">
            {shown.map((r) => (
              <li key={r.oppId}>
                <Link
                  href={`/commercial/reports/jobs/${r.oppId}`}
                  className="block rounded-xl border border-ppp-charcoal-100 bg-surface p-3.5 active:bg-ppp-charcoal-50"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 text-[13.5px] font-bold leading-snug text-ppp-charcoal break-words">{r.jobName}</span>
                    <StatusChip status={r.status} subStatus={r.subStatus} />
                  </div>
                  <p className="mt-0.5 text-[11.5px] text-ppp-charcoal-500 break-words">
                    {r.accountName}
                    {r.projectNumber ? ` · ${r.projectNumber}` : ""}
                    {r.jobYmd ? ` · ${fmtEtDate(r.jobYmd)}` : ""}
                  </p>
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11.5px]">
                    <Cell label="Contract" value={r.hasContract ? formatCentsFull(r.contractCents) : "Not set"} />
                    <Cell label="Billed" value={r.billedCents > 0 ? formatCentsFull(r.billedCents) : "Nothing yet"} />
                    <Cell label="Collected" value={r.collectedCents > 0 ? formatCentsFull(r.collectedCents) : "—"} />
                    <Cell label="Open" value={r.openBalanceCents > 0 ? formatCentsFull(r.openBalanceCents) : r.billedCents > 0 ? "Paid" : "—"} />
                    <Cell label="Cost" value={r.costCents > 0 ? formatCentsFull(r.costCents) : "None logged"} />
                    <Cell label="Margin" value={r.marginPct === null ? "—" : `${r.marginPct}%`} />
                  </dl>
                </Link>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-hidden rounded-xl border border-ppp-charcoal-100 bg-surface sm:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1080px] text-[12.5px]">
                <thead>
                  <tr className="bg-ppp-charcoal-50/60 text-left text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">
                    {JOB_SORTS.map((s) => (
                      <SortTh key={s.key} sort={s} activeKey={sortKey} activeDir={dir} qs={qs} />
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-ppp-charcoal-100">
                  {shown.map((r) => (
                    <tr key={r.oppId} className="align-top hover:bg-ppp-charcoal-50/60">
                      <td className="px-3 py-2.5">
                        <Link href={`/commercial/reports/jobs/${r.oppId}`} className="font-semibold text-cc-brand-700 hover:underline">
                          {r.jobName}
                        </Link>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                          <StatusChip status={r.status} subStatus={r.subStatus} />
                          {r.projectNumber && <span className="text-[10.5px] text-ppp-charcoal-400">{r.projectNumber}</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-ppp-charcoal-700">{r.accountName}</td>
                      <td className="px-3 py-2.5 text-ppp-charcoal-500" title={r.jobYmdIsDecided ? "Won / lost on this day" : "Created on this day — not decided yet"}>
                        {r.jobYmd ? fmtEtDate(r.jobYmd) : "—"}
                      </td>
                      <Num value={r.hasContract ? formatCentsFull(r.contractCents) : "Not set"} muted={!r.hasContract} />
                      <Num value={r.billedCents > 0 ? formatCentsFull(r.billedCents) : "Nothing yet"} muted={r.billedCents === 0} />
                      <Num value={r.collectedCents > 0 ? formatCentsFull(r.collectedCents) : "—"} muted={r.collectedCents === 0} />
                      <Num
                        value={r.openBalanceCents > 0 ? formatCentsFull(r.openBalanceCents) : r.billedCents > 0 ? "Paid" : "—"}
                        muted={r.openBalanceCents === 0}
                        className={r.openBalanceCents > 0 ? "text-amber-800" : undefined}
                      />
                      <Num value={r.costCents > 0 ? formatCentsFull(r.costCents) : "None logged"} muted={r.costCents === 0} />
                      <Num
                        value={r.marginPct === null ? "—" : `${r.marginPct}%`}
                        muted={r.marginPct === null || r.marginProvisional}
                        title={r.marginProvisional ? "No costs booked yet — this is everything billed, not profit." : undefined}
                        className={
                          r.marginPct === null || r.marginProvisional
                            ? undefined
                            : r.marginPct < 0
                              ? "text-rose-700"
                              : r.marginPct < 15
                                ? "text-amber-800"
                                : "text-emerald-700"
                        }
                      />
                      <Num
                        value={r.laborHours > 0 ? `${fmtHours(r.laborHours)}h` : "—"}
                        muted={r.laborHours === 0}
                        title={r.unratedHours > 0 ? `${fmtHours(r.unratedHours)}h have no cost rate on file` : undefined}
                        className={r.unratedHours > 0 ? "text-amber-800" : undefined}
                      />
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-ppp-charcoal-200 bg-ppp-charcoal-50/60 font-bold">
                    <td className="px-3 py-2.5 text-ppp-charcoal" colSpan={3}>
                      {totals.jobCount} {totals.jobCount === 1 ? "job" : "jobs"}
                    </td>
                    <Num value={totals.contractCents > 0 ? formatCentsFull(totals.contractCents) : "—"} />
                    <Num value={totals.billedCents > 0 ? formatCentsFull(totals.billedCents) : "—"} />
                    <Num value={totals.collectedCents > 0 ? formatCentsFull(totals.collectedCents) : "—"} />
                    <Num value={totals.openBalanceCents > 0 ? formatCentsFull(totals.openBalanceCents) : "—"} />
                    <Num value={totals.costCents > 0 ? formatCentsFull(totals.costCents) : "—"} />
                    <Num value={totals.marginPct === null ? "—" : `${totals.marginPct}%`} />
                    <Num value={totals.laborHours > 0 ? `${fmtHours(totals.laborHours)}h` : "—"} />
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

// ─── Small pieces ───────────────────────────────────────────────────────────

function unfilteredCountIn(counts: Record<string, number>): number {
  return Object.values(counts).reduce((n, v) => n + v, 0);
}

function fmtHours(h: number): string {
  return h.toLocaleString("en-US", { maximumFractionDigits: h < 100 ? 1 : 0 });
}

function FilterRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <span className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500" title={hint}>
        {label}
      </span>
      {children}
    </div>
  );
}

function Pill({ href, active, title, children }: { href: string; active: boolean; title?: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      title={title}
      aria-current={active ? "page" : undefined}
      className={`inline-flex min-h-[44px] items-center gap-1 rounded-lg border px-2.5 text-[12px] font-semibold transition-colors sm:min-h-[34px] ${
        active
          ? "border-cc-brand-600 bg-cc-brand-600 text-white"
          : "border-ppp-charcoal-200 bg-surface text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
      }`}
    >
      {children}
    </Link>
  );
}

function Count({ n }: { n: number }) {
  return <span className="text-[11px] tabular-nums opacity-70">{n}</span>;
}

function Tile({ label, value, sub, tone = "neutral" }: { label: string; value: string; sub?: string; tone?: "neutral" | "emerald" | "amber" | "rose" | "navy" }) {
  const color =
    tone === "emerald" ? "text-emerald-700"
    : tone === "amber" ? "text-amber-800"
    : tone === "rose" ? "text-rose-700"
    : tone === "navy" ? "text-ppp-navy-700"
    : "text-ppp-charcoal";
  return (
    <div className="rounded-xl border border-ppp-charcoal-100 bg-surface px-3.5 py-3">
      <div className="text-[9.5px] font-bold uppercase tracking-wider leading-tight text-ppp-charcoal-500">{label}</div>
      <div className={`font-condensed text-[20px] font-black leading-tight tabular-nums ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[10.5px] leading-snug text-ppp-charcoal-500">{sub}</div>}
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-ppp-charcoal-500">{label}</dt>
      <dd className="text-right tabular-nums text-ppp-charcoal-700">{value}</dd>
    </>
  );
}

function Num({ value, muted, className, title }: { value: string; muted?: boolean; className?: string; title?: string }) {
  return (
    <td title={title} className={`px-3 py-2.5 text-right tabular-nums ${className ?? (muted ? "text-ppp-charcoal-400" : "text-ppp-charcoal-700")}`}>
      {value}
    </td>
  );
}

function StatusChip({ status, subStatus }: { status: string; subStatus: string | null }) {
  const { cls } = statusPillTone(status, subStatus);
  return (
    <span className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0 text-[10px] font-semibold ${cls}`}>
      {oppStatusDisplayLabel(status, subStatus)}
    </span>
  );
}

function SortTh({
  sort,
  activeKey,
  activeDir,
  qs,
}: {
  sort: { key: JobSortKey; label: string; numeric: boolean };
  activeKey: JobSortKey;
  activeDir: SortDir;
  qs: (over: Record<string, string | undefined>) => string;
}) {
  const active = sort.key === activeKey;
  // Clicking the active column flips it; clicking another starts at that
  // column's own natural direction (money biggest-first, names A→Z).
  const nextDir: SortDir = active ? (activeDir === "asc" ? "desc" : "asc") : defaultDirFor(sort.key);
  return (
    <th scope="col" className={`px-3 py-0 ${sort.numeric ? "text-right" : "text-left"}`} aria-sort={active ? (activeDir === "asc" ? "ascending" : "descending") : "none"}>
      <Link
        href={qs({ sort: sort.key, dir: nextDir })}
        className={`inline-flex min-h-[44px] items-center gap-1 py-2 hover:text-ppp-charcoal ${active ? "text-cc-brand-700" : ""}`}
      >
        {sort.label}
        <span aria-hidden className={active ? "opacity-100" : "opacity-0"}>{activeDir === "asc" ? "▲" : "▼"}</span>
      </Link>
    </th>
  );
}

function EmptyBox({ title, body, cta }: { title: string; body: string; cta: { href: string; label: string } | null }) {
  return (
    <div className="rounded-xl border border-ppp-charcoal-100 bg-surface p-6 text-center">
      <p className="text-[14px] font-bold text-ppp-charcoal">{title}</p>
      <p className="mx-auto mt-1.5 max-w-md text-[12.5px] leading-relaxed text-ppp-charcoal-500">{body}</p>
      {cta && (
        <Link
          href={cta.href}
          className="mt-4 inline-flex min-h-[44px] items-center rounded-lg border border-ppp-charcoal-200 bg-surface px-4 text-[13px] font-semibold text-cc-brand-700 hover:bg-ppp-charcoal-50"
        >
          {cta.label}
        </Link>
      )}
    </div>
  );
}
