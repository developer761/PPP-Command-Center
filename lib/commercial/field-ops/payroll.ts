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
  // Resolve worker_type for EVERY entry's employee up front — the payout AND the
  // "N approved / N waiting" counts are W-2 ONLY, so subs/temps must be excluded
  // from the counts too, not just the CSV rows (audit round 6).
  const allEmpIds = [...new Set(entries.map((e) => e.employee_id))];
  const { data: emps } = await sb
    .from("commercial_employees")
    .select("id, display_name, worker_type, external_ref")
    .in("id", allEmpIds);
  const empMeta = new Map(
    (emps ?? []).map((r) => [
      (r as { id: string }).id,
      { name: (r as { display_name: string }).display_name, worker_type: (r as { worker_type: string }).worker_type, external_ref: (r as { external_ref: string | null }).external_ref },
    ])
  );
  const isW2 = (id: string) => empMeta.get(id)?.worker_type === "w2";

  const approved = entries.filter((e) => e.status === "approved" && isW2(e.employee_id));
  const unapprovedCount = entries.filter((e) => (e.status === "submitted" || e.status === "questioned") && isW2(e.employee_id)).length;
  if (approved.length === 0) return { rows: [], approvedCount: 0, unapprovedCount, periodStart, periodEnd };

  // employee -> week(Monday) -> { approved: pay now, exported: already-paid baseline }.
  // OT is computed over the FULL week (already-exported + newly-approved) so a
  // week paid across MULTIPLE export passes still credits overtime once its total
  // crosses 40h — then only the marginal, not-yet-exported hours are paid. Without
  // this, late-approved hours in an already-exported week reset the 40h baseline
  // and silently pay OT at straight time (audit round 7). W-2 only.
  const byEmpWeek = new Map<string, Map<string, { approved: number; exported: number }>>();
  for (const e of entries) {
    if (!isW2(e.employee_id)) continue;
    if (e.status !== "approved" && e.status !== "exported") continue;
    const wk = mondayOf(e.work_date);
    if (!byEmpWeek.has(e.employee_id)) byEmpWeek.set(e.employee_id, new Map());
    const wm = byEmpWeek.get(e.employee_id)!;
    const cur = wm.get(wk) ?? { approved: 0, exported: 0 };
    if (e.status === "approved") cur.approved += e.actual_hours;
    else cur.exported += e.actual_hours;
    wm.set(wk, cur);
  }

  const rows: PayrollRow[] = [];
  for (const [empId, weeks] of byEmpWeek) {
    const meta = empMeta.get(empId)!;
    let reg = 0;
    let ot = 0;
    let total = 0;
    for (const { approved: aH, exported: xH } of weeks.values()) {
      if (aH <= 0) continue; // nothing new to pay this week (already exported)
      const fullReg = Math.min(xH + aH, 40);
      const fullOt = Math.max(0, xH + aH - 40);
      const paidReg = Math.min(xH, 40);
      const paidOt = Math.max(0, xH - 40);
      reg += Math.max(0, fullReg - paidReg);
      ot += Math.max(0, fullOt - paidOt);
      total += aH;
    }
    if (total <= 0) continue;
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

/**
 * Close a payroll period: after the CSV is generated, mark the exported W-2
 * approved hours 'exported' + tag them with a pay_period, so a later (possibly
 * range-snapped, overlapping) export can't re-pay the same hours (audit round 6).
 * Idempotent — only flips 'approved' → 'exported', so a re-run/double-click finds
 * nothing left. labor-cost + overview already treat 'exported' as settled, so no
 * reader changes are needed. Uses the SAME snapped Mon–Sun span as the CSV.
 */
export async function markPayrollExported(
  fromIso: string,
  toIso: string,
  userId: string
): Promise<{ exported: number }> {
  const periodStart = mondayOf(fromIso);
  const periodEnd = addDaysIso(mondayOf(toIso), 6);
  const sb = commercialDb();

  const rows = await paginateAll<{ id: string; employee_id: string }>(() =>
    sb
      .from("commercial_time_entries")
      .select("id, employee_id")
      .eq("status", "approved")
      .gte("work_date", periodStart)
      .lte("work_date", periodEnd)
      .order("work_date")
  );
  if (rows.length === 0) return { exported: 0 };

  // W-2 only — subs/temps aren't paid through this export, so don't lock them.
  const empIds = [...new Set(rows.map((r) => r.employee_id))];
  const { data: emps } = await sb.from("commercial_employees").select("id, worker_type").in("id", empIds);
  const w2 = new Set(((emps ?? []) as { id: string; worker_type: string }[]).filter((e) => e.worker_type === "w2").map((e) => e.id));
  const ids = rows.filter((r) => w2.has(r.employee_id)).map((r) => r.id);
  if (ids.length === 0) return { exported: 0 };

  const { data: period, error: pErr } = await sb
    .from("commercial_pay_periods")
    .insert({ start_date: periodStart, end_date: periodEnd, status: "exported", exported_at: new Date().toISOString(), exported_by_user_id: userId })
    .select("id")
    .single();
  if (pErr || !period) return { exported: 0 };
  const periodId = (period as { id: string }).id;

  let exported = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const { error } = await sb
      .from("commercial_time_entries")
      .update({ status: "exported", pay_period_id: periodId, updated_at: new Date().toISOString() })
      .in("id", chunk)
      .eq("status", "approved"); // race guard: only flip still-approved rows
    if (!error) exported += chunk.length;
  }
  return { exported };
}
