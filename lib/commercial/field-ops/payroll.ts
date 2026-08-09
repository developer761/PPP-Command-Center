import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { mondayOf, addDaysIso } from "./schedule";

/**
 * R10.5 Payroll - export APPROVED time for a date range as a per-employee
 * summary + CSV. W-2 only (subs/temps excluded by construction). Overtime is
 * split at 40h per week (bucketed by the Monday of each work week).
 *
 * Because OT is a whole-week (40h) concept, the requested range is SNAPPED
 * outward to complete Monday-Sunday weeks — otherwise a range that starts or
 * ends mid-week would only see part of a week and under/over-count OT. The
 * effective (snapped) period is returned so the CSV + UI show the true span.
 */

export type PayrollRow = {
  employee_id: string;
  employee_name: string;
  external_ref: string | null;
  totalHours: number;
  regHours: number;
  otHours: number;
};

export type PayrollSummary = {
  rows: PayrollRow[];
  approvedCount: number;
  unapprovedCount: number;
  periodStart: string; // snapped to a Monday
  periodEnd: string; // snapped to the following Sunday
};

export async function getPayrollSummary(fromIso: string, toIso: string): Promise<PayrollSummary> {
  const periodStart = mondayOf(fromIso);
  const periodEnd = addDaysIso(mondayOf(toIso), 6); // Sunday of the week containing `to`
  const sb = commercialDb();
  const entries = await paginateAll<{ employee_id: string; work_date: string; actual_hours: number; status: string }>(() =>
    sb
      .from("commercial_time_entries")
      .select("employee_id, work_date, actual_hours, status")
      .gte("work_date", periodStart)
      .lte("work_date", periodEnd)
      .order("work_date")
  );
  const approved = entries.filter((e) => e.status === "approved");
  const unapprovedCount = entries.filter((e) => e.status === "submitted" || e.status === "questioned").length;
  if (approved.length === 0) return { rows: [], approvedCount: 0, unapprovedCount, periodStart, periodEnd };

  const empIds = [...new Set(approved.map((e) => e.employee_id))];
  const { data: emps } = await sb
    .from("commercial_employees")
    .select("id, display_name, worker_type, external_ref")
    .in("id", empIds);
  const empMeta = new Map(
    (emps ?? []).map((r) => [
      (r as { id: string }).id,
      { name: (r as { display_name: string }).display_name, worker_type: (r as { worker_type: string }).worker_type, external_ref: (r as { external_ref: string | null }).external_ref },
    ])
  );

  // employee -> week(Monday) -> hours
  const byEmpWeek = new Map<string, Map<string, number>>();
  for (const e of approved) {
    const meta = empMeta.get(e.employee_id);
    if (!meta || meta.worker_type !== "w2") continue; // W-2 only
    const wk = mondayOf(e.work_date);
    if (!byEmpWeek.has(e.employee_id)) byEmpWeek.set(e.employee_id, new Map());
    const wm = byEmpWeek.get(e.employee_id)!;
    wm.set(wk, (wm.get(wk) ?? 0) + e.actual_hours);
  }

  const rows: PayrollRow[] = [];
  for (const [empId, weeks] of byEmpWeek) {
    const meta = empMeta.get(empId)!;
    let reg = 0;
    let ot = 0;
    let total = 0;
    for (const h of weeks.values()) {
      total += h;
      reg += Math.min(h, 40);
      ot += Math.max(0, h - 40);
    }
    rows.push({
      employee_id: empId,
      employee_name: meta.name,
      external_ref: meta.external_ref,
      totalHours: Math.round(total * 100) / 100,
      regHours: Math.round(reg * 100) / 100,
      otHours: Math.round(ot * 100) / 100,
    });
  }
  rows.sort((a, b) => a.employee_name.localeCompare(b.employee_name));
  return { rows, approvedCount: approved.length, unapprovedCount, periodStart, periodEnd };
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function buildPayrollCsv(fromIso: string, toIso: string): Promise<string> {
  const { rows, periodStart, periodEnd } = await getPayrollSummary(fromIso, toIso);
  const header = ["Employee", "External Ref", "Regular Hours", "Overtime Hours", "Total Hours", "Period Start", "Period End"];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    // Period columns use the SNAPPED full-week span so OT reconciles.
    lines.push([r.employee_name, r.external_ref ?? "", r.regHours, r.otHours, r.totalHours, periodStart, periodEnd].map(csvCell).join(","));
  }
  return lines.join("\r\n");
}
