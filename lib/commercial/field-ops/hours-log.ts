import "server-only";

import { commercialDb } from "@/lib/commercial/db";

export type HoursLogJob = { job_id: string; job_name: string; job_code: string; hours: number };
export type HoursLogRow = {
  employee_id: string;
  employee_name: string;
  total_hours: number;
  jobs: HoursLogJob[]; // per-work-order breakdown, most hours first
};

/**
 * Per-crew-member hours for a date range [startIso, endIso] inclusive, with a
 * per-work-order breakdown (Karan 2026-08 Hours Log tab). Sourced from
 * time_entries.actual_hours — the SAME actuals Payroll + Approvals read — so the
 * numbers always agree. Counts every logged status (submitted / questioned /
 * approved / exported): it's a record of hours worked, not an approval gate.
 * Deleted work orders still resolve their name (worked hours are worked hours).
 */
export async function getHoursLog(
  startIso: string,
  endIso: string
): Promise<{ rows: HoursLogRow[]; totalHours: number }> {
  const sb = commercialDb();
  const { data: eRows } = await sb
    .from("commercial_time_entries")
    .select("employee_id, job_id, actual_hours")
    .gte("work_date", startIso)
    .lte("work_date", endIso);
  const entries = (eRows ?? []) as { employee_id: string; job_id: string; actual_hours: number }[];

  const byEmp = new Map<string, Map<string, number>>(); // employee → job → hours
  const empTotal = new Map<string, number>();
  let grand = 0;
  for (const e of entries) {
    const h = Number(e.actual_hours ?? 0);
    if (h <= 0) continue;
    if (!byEmp.has(e.employee_id)) byEmp.set(e.employee_id, new Map());
    const jm = byEmp.get(e.employee_id)!;
    jm.set(e.job_id, (jm.get(e.job_id) ?? 0) + h);
    empTotal.set(e.employee_id, (empTotal.get(e.employee_id) ?? 0) + h);
    grand += h;
  }
  if (byEmp.size === 0) return { rows: [], totalHours: 0 };

  const empIds = [...byEmp.keys()];
  const jobIds = [...new Set(entries.map((e) => e.job_id))];
  const [empRes, jobRes] = await Promise.all([
    sb.from("commercial_employees").select("id, display_name").in("id", empIds),
    sb.from("commercial_jobs").select("id, name, job_code").in("id", jobIds),
  ]);
  const empName = new Map(
    (empRes.data ?? []).map((r) => [(r as { id: string }).id, (r as { display_name: string | null }).display_name])
  );
  const jobMeta = new Map(
    (jobRes.data ?? []).map((r) => {
      const j = r as { id: string; name: string | null; job_code: string | null };
      return [j.id, j];
    })
  );

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const rows: HoursLogRow[] = empIds
    .map((id) => {
      const jm = byEmp.get(id)!;
      const jobs: HoursLogJob[] = [...jm.entries()]
        .map(([jid, hours]) => ({
          job_id: jid,
          job_name: (jobMeta.get(jid)?.name ?? "").trim() || "(work order)",
          job_code: jobMeta.get(jid)?.job_code ?? "",
          hours: round2(hours),
        }))
        .sort((a, b) => b.hours - a.hours || a.job_name.localeCompare(b.job_name));
      return {
        employee_id: id,
        employee_name: (empName.get(id) ?? "").trim() || "(crew)",
        total_hours: round2(empTotal.get(id) ?? 0),
        jobs,
      };
    })
    .sort((a, b) => b.total_hours - a.total_hours || a.employee_name.localeCompare(b.employee_name));

  return { rows, totalHours: round2(grand) };
}
