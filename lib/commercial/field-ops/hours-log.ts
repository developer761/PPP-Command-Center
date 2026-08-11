import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { absenceLabel } from "./absence-constants";

export type HoursLogJob = {
  job_id: string;
  job_name: string;
  job_code: string;
  scheduled_hours: number;
  worked_hours: number;
};
export type HoursLogAbsence = { work_date: string; reason: string; hours: number | null };
export type HoursLogRow = {
  employee_id: string;
  employee_name: string;
  scheduled_hours: number;
  worked_hours: number;
  jobs: HoursLogJob[];
  absences: HoursLogAbsence[]; // days marked off in the window (reason + hours)
};

/**
 * Per-crew-member hours for a date range [startIso, endIso] inclusive (Karan
 * 2026-08 Hours Log). Now shows SCHEDULED vs WORKED per work order:
 *   - worked  = time_entries.actual_hours (the SAME actuals Payroll + Approvals
 *     read, so the numbers always agree; every logged status counts — it's a
 *     record of hours worked, not an approval gate).
 *   - scheduled = commercial_assignments.scheduled_hours (non-cancelled).
 * Plus any days the crew member was marked OFF in the window, with the reason —
 * so "scheduled 40 / worked 32 · Off: Sick (Wed)" reads at a glance. The row set
 * is the UNION of anyone who worked, was scheduled, or was marked off (so a
 * scheduled no-show still appears with worked = 0). Deleted work orders still
 * resolve their name.
 */
export async function getHoursLog(
  startIso: string,
  endIso: string
): Promise<{ rows: HoursLogRow[]; totalScheduled: number; totalWorked: number }> {
  const sb = commercialDb();
  // All three sources paginated — a wide range across a full crew can exceed
  // Supabase's silent 1000-row cap, which would undercount + drop crew.
  const [entries, assigns, absences] = await Promise.all([
    paginateAll<{ employee_id: string; job_id: string; actual_hours: number }>(() =>
      sb
        .from("commercial_time_entries")
        .select("employee_id, job_id, actual_hours")
        .gte("work_date", startIso)
        .lte("work_date", endIso)
        .order("work_date")
        .order("id")
    ),
    paginateAll<{ employee_id: string; job_id: string; scheduled_hours: number }>(() =>
      sb
        .from("commercial_assignments")
        .select("employee_id, job_id, scheduled_hours")
        .gte("work_date", startIso)
        .lte("work_date", endIso)
        .neq("status", "cancelled")
        .order("work_date")
        .order("id")
    ),
    paginateAll<{ employee_id: string; work_date: string; type: string; hours: number | null }>(() =>
      sb
        .from("commercial_absences")
        .select("employee_id, work_date, type, hours")
        .gte("work_date", startIso)
        .lte("work_date", endIso)
        .order("work_date")
        .order("id")
    ),
  ]);

  // employee → job → { scheduled, worked }
  const byEmpJob = new Map<string, Map<string, { sched: number; worked: number }>>();
  const empSched = new Map<string, number>();
  const empWorked = new Map<string, number>();
  let grandSched = 0;
  let grandWorked = 0;
  const slot = (emp: string, job: string) => {
    if (!byEmpJob.has(emp)) byEmpJob.set(emp, new Map());
    const jm = byEmpJob.get(emp)!;
    if (!jm.has(job)) jm.set(job, { sched: 0, worked: 0 });
    return jm.get(job)!;
  };
  for (const e of entries) {
    const h = Number(e.actual_hours ?? 0);
    if (h <= 0) continue;
    slot(e.employee_id, e.job_id).worked += h;
    empWorked.set(e.employee_id, (empWorked.get(e.employee_id) ?? 0) + h);
    grandWorked += h;
  }
  for (const a of assigns) {
    const h = Number(a.scheduled_hours ?? 0);
    if (h <= 0) continue;
    slot(a.employee_id, a.job_id).sched += h;
    empSched.set(a.employee_id, (empSched.get(a.employee_id) ?? 0) + h);
    grandSched += h;
  }
  const absByEmp = new Map<string, HoursLogAbsence[]>();
  for (const ab of absences) {
    const list = absByEmp.get(ab.employee_id) ?? [];
    list.push({
      work_date: String(ab.work_date).slice(0, 10),
      reason: absenceLabel(ab.type),
      hours: ab.hours == null ? null : Number(ab.hours),
    });
    absByEmp.set(ab.employee_id, list);
  }

  const empIds = [...new Set([...byEmpJob.keys(), ...absByEmp.keys()])];
  if (empIds.length === 0) return { rows: [], totalScheduled: 0, totalWorked: 0 };
  const jobIds = [...new Set([...entries.map((e) => e.job_id), ...assigns.map((a) => a.job_id)])];
  const [empRes, jobRes] = await Promise.all([
    sb.from("commercial_employees").select("id, display_name").in("id", empIds),
    jobIds.length
      ? sb.from("commercial_jobs").select("id, name, job_code").in("id", jobIds)
      : Promise.resolve({ data: [] as { id: string; name: string | null; job_code: string | null }[] }),
  ]);
  const empName = new Map(
    (empRes.data ?? []).map((r) => [(r as { id: string }).id, (r as { display_name: string | null }).display_name])
  );
  const jobMeta = new Map(
    ((jobRes.data ?? []) as { id: string; name: string | null; job_code: string | null }[]).map((j) => [j.id, j])
  );

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const rows: HoursLogRow[] = empIds
    .map((id) => {
      const jm = byEmpJob.get(id) ?? new Map<string, { sched: number; worked: number }>();
      const jobs: HoursLogJob[] = [...jm.entries()]
        .map(([jid, v]) => ({
          job_id: jid,
          job_name: (jobMeta.get(jid)?.name ?? "").trim() || "(work order)",
          job_code: jobMeta.get(jid)?.job_code ?? "",
          scheduled_hours: round2(v.sched),
          worked_hours: round2(v.worked),
        }))
        .sort((a, b) => b.worked_hours - a.worked_hours || b.scheduled_hours - a.scheduled_hours || a.job_name.localeCompare(b.job_name));
      return {
        employee_id: id,
        employee_name: (empName.get(id) ?? "").trim() || "(crew)",
        scheduled_hours: round2(empSched.get(id) ?? 0),
        worked_hours: round2(empWorked.get(id) ?? 0),
        jobs,
        absences: (absByEmp.get(id) ?? []).sort((a, b) => a.work_date.localeCompare(b.work_date)),
      };
    })
    .sort((a, b) => b.worked_hours - a.worked_hours || b.scheduled_hours - a.scheduled_hours || a.employee_name.localeCompare(b.employee_name));

  return { rows, totalScheduled: round2(grandSched), totalWorked: round2(grandWorked) };
}

// ── Crew self-service (scoped to ONE employee) ─────────────────────────────

export type MyHoursDay = {
  work_date: string;
  job_name: string;
  scheduled_hours: number;
  worked_hours: number;
};

/**
 * One crew member's own hours for a window.
 *
 * A separate query rather than a filter over getHoursLog: that one builds the
 * whole company's rows (every employee, all totals) and handing a crew member a
 * filtered slice of it puts the entire payroll one dropped filter away. Here
 * employee_id is in the WHERE clause of both reads.
 *
 * Returns their scheduled-vs-worked per day per job. No company totals, no
 * other people, no approval controls — those live on the admin Hours Log.
 */
export async function getMyHoursLog(
  employeeId: string,
  startIso: string,
  endIso: string
): Promise<{ days: MyHoursDay[]; totalScheduled: number; totalWorked: number }> {
  if (!employeeId) return { days: [], totalScheduled: 0, totalWorked: 0 };
  const sb = commercialDb();

  // Paginated with an order tiebreak, like getHoursLog above: Supabase caps a
  // bare select at 1000 rows SILENTLY, and a crew member with a long history
  // would quietly under-report their own hours — the one number they check.
  const [entries, assigns] = await Promise.all([
    paginateAll<{ work_date: string; job_id: string | null; actual_hours: number | null }>(() =>
      sb
        .from("commercial_time_entries")
        .select("work_date, job_id, actual_hours")
        .eq("employee_id", employeeId)
        .gte("work_date", startIso)
        .lte("work_date", endIso)
        .order("id", { ascending: true })
    ),
    paginateAll<{ work_date: string; job_id: string | null; scheduled_hours: number | null }>(() =>
      sb
        .from("commercial_assignments")
        .select("work_date, job_id, scheduled_hours")
        .eq("employee_id", employeeId)
        .neq("status", "cancelled")
        .gte("work_date", startIso)
        .lte("work_date", endIso)
        .order("id", { ascending: true })
    ),
  ]);

  const key = (d: string, j: string | null) => `${d}|${j ?? ""}`;
  const acc = new Map<string, MyHoursDay & { job_id: string | null }>();
  const touch = (work_date: string, job_id: string | null) => {
    const k = key(work_date, job_id);
    let row = acc.get(k);
    if (!row) {
      row = { work_date, job_id, job_name: "", scheduled_hours: 0, worked_hours: 0 };
      acc.set(k, row);
    }
    return row;
  };
  for (const a of assigns) {
    touch(a.work_date, a.job_id).scheduled_hours += Number(a.scheduled_hours ?? 0);
  }
  for (const e of entries) {
    touch(e.work_date, e.job_id).worked_hours += Number(e.actual_hours ?? 0);
  }

  const jobIds = Array.from(new Set(Array.from(acc.values()).map((r) => r.job_id).filter(Boolean) as string[]));
  if (jobIds.length > 0) {
    // Deleted work orders still resolve their name, same as the admin log —
    // a crew member shouldn't see a blank row for a job that was torn down.
    const { data: jobs } = await sb.from("commercial_jobs").select("id, name").in("id", jobIds);
    const nameById = new Map((((jobs ?? []) as { id: string; name: string | null }[])).map((j) => [j.id, j.name ?? "Job"]));
    for (const r of acc.values()) r.job_name = r.job_id ? nameById.get(r.job_id) ?? "Job" : "—";
  } else {
    for (const r of acc.values()) r.job_name = "—";
  }

  const days = Array.from(acc.values())
    .map(({ job_id: _job_id, ...rest }) => rest)
    .sort((a, b) => a.work_date.localeCompare(b.work_date) || a.job_name.localeCompare(b.job_name));
  return {
    days,
    totalScheduled: days.reduce((s, d) => s + d.scheduled_hours, 0),
    totalWorked: days.reduce((s, d) => s + d.worked_hours, 0),
  };
}
