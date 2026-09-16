import type { NextRequest } from "next/server";
import { csvEscape as csv } from "@/lib/commercial/csv";
import { guardExport, csvResponse } from "@/lib/commercial/reports/export-guard";
import { getJobsOverviewRows } from "@/lib/commercial/reports/jobs";
import {
  filterJobRows,
  resolveGroupFilter,
  resolveSort,
  sortJobRows,
  summarizeJobRows,
  JOB_GROUPS,
} from "@/lib/commercial/reports/jobs-rows";
import { ACTIVITY_PRESETS, ACTIVITY_DEFAULT, activityRange, resolvePreset } from "@/lib/commercial/reports/presets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The jobs list, as a spreadsheet — EXACTLY the rows on screen.
 *
 * Every filter is resolved through the same pure functions the page uses
 * (`resolveGroupFilter` / `activityRange` / `filterJobRows` / `sortJobRows`), so
 * the file can't quietly cover a different set than the screen it came from.
 * That is a silent kind of wrong: you can't see it in the download.
 *
 * Amounts are plain numbers (no currency symbol, no thousands separator) so
 * Excel treats the columns as money and can sum them.
 */
export async function GET(req: NextRequest) {
  const guard = await guardExport({ report: "jobs" });
  if (!guard.ok) return guard.response;

  const p = req.nextUrl.searchParams;
  const q = (p.get("q") ?? "").slice(0, 120);
  const group = resolveGroupFilter(p.get("group") ?? undefined);
  const gc = p.get("gc") ?? "all";
  const preset = resolvePreset(p.get("preset") ?? undefined, ACTIVITY_PRESETS, ACTIVITY_DEFAULT);
  const range = activityRange(preset);
  const { key: sortKey, dir } = resolveSort(p.get("sort") ?? undefined, p.get("dir") ?? undefined);

  const all = await getJobsOverviewRows();
  const filtered = filterJobRows(all, { q, group, gc, fromYmd: range?.fromYmd ?? null, toYmd: range?.toYmd ?? null });
  const rows = sortJobRows(filtered, sortKey, dir);
  const t = summarizeJobRows(filtered);

  const d = (cents: number) => (cents / 100).toFixed(2);
  const L: string[] = [];
  const row = (...cells: (string | number | null | undefined)[]) => L.push(cells.map((c) => csv(c ?? "")).join(","));

  const windowLabel = range ? `${range.label} (${range.fromYmd} to ${range.toYmd})` : "All time";
  row("Filters", `Status: ${group === "all" ? "All" : JOB_GROUPS.find((g) => g.key === group)?.label ?? group}`, `Period: ${windowLabel}`, q ? `Search: ${q}` : "", gc === "all" ? "GC: every GC" : "GC: filtered");
  row("");
  row("Jobs", t.jobCount, "GCs", t.gcCount);
  row("Contract", d(t.contractCents), "Billed (pre-tax)", d(t.billedCents), "Collected", d(t.collectedCents));
  row("Open balance", d(t.openBalanceCents), "Retainage held", d(t.retainageHeldCents), "Cost", d(t.costCents));
  row(t.marginLabel, d(t.marginCents), "Margin %", t.marginPct === null ? "" : t.marginPct, t.marginCaveat ?? "");
  row("Labor hours", t.laborHours, "Hours with no cost rate", t.unratedHours);
  row("Open", t.byGroup.open, "In delivery", t.byGroup.delivery, "Closed", t.byGroup.closed, "Lost", t.byGroup.lost);
  row("");
  // The one caveat that would otherwise be lost the moment the file leaves the
  // screen that explains it.
  row("Note", "Each job's figures are for its whole life. The period selects WHICH jobs, by job date — it does not slice the money by when it moved.");
  row("");

  row(
    "Job", "GC", "Project no.", "Deal no.", "Address", "Status", "Sub-status", "Group",
    "Job date", "Job date is", "Contract", "Billed (pre-tax)", "Collected", "Open balance",
    "Retainage held", "Cost", "Margin", "Margin %", "Labor hours", "Unpriced hours",
    "Invoices", "Pending COs", "Link"
  );
  const origin = req.nextUrl.origin;
  for (const r of rows) {
    row(
      r.jobName,
      r.accountName,
      r.projectNumber,
      r.dealNumber,
      r.address,
      r.status,
      r.subStatus,
      JOB_GROUPS.find((g) => g.key === r.group)?.label ?? r.group,
      r.jobYmd,
      r.jobYmd ? (r.jobYmdIsDecided ? "decided" : "created") : "",
      r.hasContract ? d(r.contractCents) : "",
      d(r.billedCents),
      d(r.collectedCents),
      d(r.openBalanceCents),
      d(r.retainageHeldCents),
      d(r.costCents),
      d(r.marginCents),
      r.marginPct === null ? "" : r.marginPct,
      r.laborHours,
      r.unratedHours,
      r.invoiceCount,
      r.pendingCoCount,
      `${origin}/commercial/reports/jobs/${r.oppId}`
    );
  }

  const stamp = range ? `${range.fromYmd}_to_${range.toYmd}` : "all-time";
  return csvResponse(L.join("\r\n") + "\r\n", `Jobs_${stamp}.csv`, "Jobs", windowLabel);
}
