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
  const entries = await paginateAll<{ id: string; employee_id: string; work_date: string; actual_hours: number; status: string }>(() =>
    sb
      .from("commercial_time_entries")
      .select("id, employee_id, work_date, actual_hours, status")
      .gte("work_date", periodStart)
      .lte("work_date", periodEnd)
      .order("work_date")
      .order("id")
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

/** Marginal reg/OT for one employee across their weeks, given each week's
 *  already-exported baseline (xH) and the hours being paid now (aH). */
function marginalRegOt(weeks: Map<string, { pay: number; base: number }>): { reg: number; ot: number; total: number } {
  let reg = 0, ot = 0, total = 0;
  for (const { pay: aH, base: xH } of weeks.values()) {
    if (aH <= 0) continue;
    reg += Math.max(0, Math.min(xH + aH, 40) - Math.min(xH, 40));
    ot += Math.max(0, Math.max(0, xH + aH - 40) - Math.max(0, xH - 40));
    total += aH;
  }
  return { reg: Math.round(reg * 100) / 100, ot: Math.round(ot * 100) / 100, total: Math.round(total * 100) / 100 };
}

/**
 * ATOMIC export: lock the approved W-2 hours (approved → exported) FIRST via a
 * single UPDATE ... RETURNING, then build the CSV from EXACTLY the rows that
 * locked. This closes the build-then-lock window where a row de-approved by a
 * concurrent same-day clock-out could be paid on the CSV but never locked (→
 * double-pay), and where a concurrent approval could be locked but never paid
 * (audit rounds 12 + 13). The read-only getPayrollSummary above stays for the
 * on-screen preview (no locking). One snapped Mon–Sun week is well under the
 * 1000-row RETURNING window; export weekly.
 */
/**
 * Re-issue the CSV for a period already exported, WITHOUT touching a single
 * row's status.
 *
 * The export is deliberately one-shot and atomic (audit rounds 6, 12, 13):
 * approved rows flip to exported before the CSV is built, so nothing is ever
 * paid-but-unlocked or locked-but-unpaid, and a repeat export returns an empty
 * file meaning "already paid". That is right, and this does not change it.
 *
 * What it fixes is the other half: if the download is interrupted — a dropped
 * connection, a closed tab, a misclick — the hours are locked and the file is
 * gone for good, with payroll still to run. This rebuilds the same figures
 * from the rows already marked exported. Read-only: no period is created, no
 * status changes, so it cannot cause a double payment.
 */
export async function redownloadPayroll(fromIso: string, toIso: string): Promise<string> {
  const periodStart = mondayOf(fromIso);
  const periodEnd = addDaysIso(mondayOf(toIso), 6);
  const sb = commercialDb();

  const { data: emps } = await sb.from("commercial_employees").select("id, display_name, worker_type, external_ref");
  const empMeta = new Map(
    (emps ?? []).map((r) => [(r as { id: string }).id, { name: (r as { display_name: string }).display_name, external_ref: (r as { external_ref: string | null }).external_ref }])
  );
  const w2Ids = ((emps ?? []) as { id: string; worker_type: string }[]).filter((e) => e.worker_type === "w2").map((e) => e.id);
  const header = ["Employee", "External Ref", "Regular Hours", "Overtime Hours", "Total Hours", "Period Start", "Period End"];
  const emptyCsv = header.map(csvCell).join(",");
  if (w2Ids.length === 0) return emptyCsv;

  const rows = await paginateAll<{ employee_id: string; work_date: string; actual_hours: number }>(() =>
    sb
      .from("commercial_time_entries")
      .select("employee_id, work_date, actual_hours")
      .eq("status", "exported")
      .gte("work_date", periodStart)
      .lte("work_date", periodEnd)
      .in("employee_id", w2Ids)
      .order("id")
  );
  if (rows.length === 0) return emptyCsv;

  const totals = new Map<string, number>();
  for (const r of rows) {
    totals.set(r.employee_id, (totals.get(r.employee_id) ?? 0) + (Number(r.actual_hours) || 0));
  }
  const lines = [header.map(csvCell).join(",")];
  for (const [empId, total] of [...totals.entries()].sort((a, b) =>
    (empMeta.get(a[0])?.name ?? "").localeCompare(empMeta.get(b[0])?.name ?? "")
  )) {
    const meta = empMeta.get(empId);
    const regular = Math.min(40, total);
    const overtime = Math.max(0, total - 40);
    lines.push(
      [meta?.name ?? "Unknown", meta?.external_ref ?? "", regular, overtime, total, periodStart, periodEnd]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\n");
}

export async function exportPayroll(fromIso: string, toIso: string, userId: string): Promise<string> {
  const periodStart = mondayOf(fromIso);
  const periodEnd = addDaysIso(mondayOf(toIso), 6);
  const sb = commercialDb();

  const { data: emps } = await sb.from("commercial_employees").select("id, display_name, worker_type, external_ref");
  const empMeta = new Map(
    (emps ?? []).map((r) => [(r as { id: string }).id, { name: (r as { display_name: string }).display_name, external_ref: (r as { external_ref: string | null }).external_ref }])
  );
  const w2Ids = ((emps ?? []) as { id: string; worker_type: string }[]).filter((e) => e.worker_type === "w2").map((e) => e.id);

  const header = ["Employee", "External Ref", "Regular Hours", "Overtime Hours", "Total Hours", "Period Start", "Period End"];
  const emptyCsv = header.map(csvCell).join(",");
  if (w2Ids.length === 0) return emptyCsv;

  // Already-exported W-2 hours in range → the OT baseline for a multi-pass week.
  const baseline = await paginateAll<{ employee_id: string; work_date: string; actual_hours: number }>(() =>
    sb
      .from("commercial_time_entries")
      .select("employee_id, work_date, actual_hours")
      .eq("status", "exported")
      .gte("work_date", periodStart)
      .lte("work_date", periodEnd)
      .in("employee_id", w2Ids)
      .order("work_date")
      .order("id")
  );

  // Approved W-2 entry ids in range to lock — PAGINATED so a >1000-entry export
  // isn't silently truncated (audit round 15).
  const toLock = await paginateAll<{ id: string }>(() =>
    sb
      .from("commercial_time_entries")
      .select("id")
      .eq("status", "approved")
      .gte("work_date", periodStart)
      .lte("work_date", periodEnd)
      .in("employee_id", w2Ids)
      .order("id")
  );
  if (toLock.length === 0) return emptyCsv; // nothing approved to pay — create no period

  const { data: period, error: pErr } = await sb
    .from("commercial_pay_periods")
    .insert({ start_date: periodStart, end_date: periodEnd, status: "exported", exported_at: new Date().toISOString(), exported_by_user_id: userId })
    .select("id")
    .single();
  if (pErr || !period) return emptyCsv;
  const periodId = (period as { id: string }).id;

  // Flip approved → exported in CHUNKS, RETURNING each locked row. A single
  // UPDATE...RETURNING would flip ALL matching rows but return only the first 1000,
  // leaving the overflow locked-but-unpaid; chunks of 500 stay under the RETURNING
  // cap so the CSV pays EXACTLY what locked. The status guard means a row
  // de-approved after the id snapshot isn't flipped and isn't paid (rounds 13 + 15).
  const paid: { employee_id: string; work_date: string; actual_hours: number }[] = [];
  const ids = toLock.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const { data } = await sb
      .from("commercial_time_entries")
      .update({ status: "exported", pay_period_id: periodId, updated_at: new Date().toISOString() })
      .in("id", chunk)
      .eq("status", "approved")
      .select("employee_id, work_date, actual_hours");
    if (data) paid.push(...(data as { employee_id: string; work_date: string; actual_hours: number }[]));
  }

  // employee -> week -> { pay: just-locked, base: already-exported }.
  const byEmp = new Map<string, Map<string, { pay: number; base: number }>>();
  const bucket = (empId: string, date: string, hours: number, kind: "pay" | "base") => {
    const wk = mondayOf(date);
    if (!byEmp.has(empId)) byEmp.set(empId, new Map());
    const wm = byEmp.get(empId)!;
    const cur = wm.get(wk) ?? { pay: 0, base: 0 };
    cur[kind] += hours;
    wm.set(wk, cur);
  };
  for (const e of baseline) bucket(e.employee_id, e.work_date, e.actual_hours, "base");
  for (const e of paid) bucket(e.employee_id, e.work_date, e.actual_hours, "pay");

  const lines = [emptyCsv];
  const rows: { name: string; ref: string | null; reg: number; ot: number; total: number }[] = [];
  for (const [empId, weeks] of byEmp) {
    const { reg, ot, total } = marginalRegOt(weeks);
    if (total <= 0) continue; // baseline-only employee (nothing new to pay)
    const meta = empMeta.get(empId);
    rows.push({ name: meta?.name ?? "(crew)", ref: meta?.external_ref ?? null, reg, ot, total });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  for (const r of rows) {
    lines.push([r.name, r.ref ?? "", r.reg, r.ot, r.total, periodStart, periodEnd].map(csvCell).join(","));
  }
  return lines.join("\r\n");
}

