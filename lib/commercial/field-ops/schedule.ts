import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";
import { listEmployees } from "./employees";

/**
 * R10.1 Week Grid - the primary scheduling surface. Mirrors Tomco's spreadsheet:
 * employees across the top, jobs down the left grouped by day (Mon-Sat), hours in
 * click-to-edit cells. Scheduled = assignments; Approved/Questioned = time_entries.
 *
 * Dates are plain YYYY-MM-DD and all week math is done in UTC so it never shifts.
 */

export function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** Monday of the week containing `iso`. */
export function mondayOf(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
  return addDaysIso(iso, dow === 0 ? -6 : 1 - dow);
}

/** Today in America/New_York as YYYY-MM-DD. */
export function todayEtIso(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

const DAY_LABELS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export type WeekCell = { assignmentId: string; scheduled: number; actual: number | null; status: string };
export type WeekJobRow = {
  job: { id: string; name: string; job_code: string; prevailing_wage: boolean };
  cells: Record<string, WeekCell>; // employee_id -> cell
};
export type WeekDay = { date: string; label: string; rows: WeekJobRow[] };
export type WeekEmployee = { id: string; display_name: string; default_daily_hours: number };
export type WeekSchedule = {
  weekStart: string;
  days: WeekDay[];
  employees: WeekEmployee[];
  colScheduled: Record<string, number>; // employee_id -> scheduled total
  colActual: Record<string, number>;
  grandScheduled: number;
  grandActual: number;
};

export async function getWeekSchedule(mondayIso: string): Promise<WeekSchedule> {
  const start = mondayOf(mondayIso);
  const dates = Array.from({ length: 6 }, (_, i) => addDaysIso(start, i)); // Mon..Sat
  const sb = commercialDb();

  const [emps, assignRes, entryRes] = await Promise.all([
    listEmployees(),
    sb
      .from("commercial_assignments")
      .select("id, job_id, employee_id, work_date, scheduled_hours, status")
      .in("work_date", dates)
      .neq("status", "cancelled"),
    sb
      .from("commercial_time_entries")
      .select("job_id, employee_id, work_date, actual_hours, status")
      .in("work_date", dates),
  ]);

  const assignments = (assignRes.data ?? []) as {
    id: string; job_id: string; employee_id: string; work_date: string; scheduled_hours: number; status: string;
  }[];
  const entries = (entryRes.data ?? []) as {
    job_id: string; employee_id: string; work_date: string; actual_hours: number; status: string;
  }[];

  // Job metadata for every job that appears this week.
  const jobIds = [...new Set(assignments.map((a) => a.job_id))];
  const jobsById = new Map<string, { id: string; name: string; job_code: string; prevailing_wage: boolean }>();
  if (jobIds.length > 0) {
    const { data: jobs } = await sb
      .from("commercial_jobs")
      .select("id, name, job_code, prevailing_wage")
      .in("id", jobIds);
    for (const j of (jobs ?? []) as { id: string; name: string; job_code: string; prevailing_wage: boolean }[]) {
      jobsById.set(j.id, j);
    }
  }

  // actual lookup
  const actualKey = (jid: string, eid: string, date: string) => `${jid}|${eid}|${date}`;
  const actualMap = new Map<string, { hours: number; status: string }>();
  for (const e of entries) actualMap.set(actualKey(e.job_id, e.employee_id, e.work_date), { hours: e.actual_hours, status: e.status });

  const colScheduled: Record<string, number> = {};
  const colActual: Record<string, number> = {};
  let grandScheduled = 0;
  let grandActual = 0;

  const days: WeekDay[] = dates.map((date, i) => {
    // job rows for this day: group assignments by job
    const byJob = new Map<string, WeekJobRow>();
    for (const a of assignments.filter((x) => x.work_date === date)) {
      const meta = jobsById.get(a.job_id);
      if (!meta) continue;
      let row = byJob.get(a.job_id);
      if (!row) {
        row = { job: meta, cells: {} };
        byJob.set(a.job_id, row);
      }
      const act = actualMap.get(actualKey(a.job_id, a.employee_id, date));
      row.cells[a.employee_id] = {
        assignmentId: a.id,
        scheduled: a.scheduled_hours,
        actual: act?.hours ?? null,
        status: act?.status ?? a.status,
      };
      colScheduled[a.employee_id] = (colScheduled[a.employee_id] ?? 0) + a.scheduled_hours;
      grandScheduled += a.scheduled_hours;
      if (act) {
        colActual[a.employee_id] = (colActual[a.employee_id] ?? 0) + act.hours;
        grandActual += act.hours;
      }
    }
    const rows = [...byJob.values()].sort((x, y) => x.job.name.localeCompare(y.job.name));
    return { date, label: DAY_LABELS[i], rows };
  });

  return {
    weekStart: start,
    days,
    employees: emps.map((e) => ({ id: e.id, display_name: e.display_name, default_daily_hours: e.default_daily_hours })),
    colScheduled,
    colActual,
    grandScheduled,
    grandActual,
  };
}

/**
 * Set the scheduled hours for one (job, employee, date). Hours <= 0 removes the
 * assignment. Returns the assignment id (or null if removed). Upsert on the
 * UNIQUE(job, employee, date).
 */
export async function setAssignmentHours(input: {
  job_id: string;
  employee_id: string;
  work_date: string;
  hours: number;
  actor_user_id: string;
}): Promise<{ ok: true; assignmentId: string | null } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: existing } = await sb
    .from("commercial_assignments")
    .select("*")
    .eq("job_id", input.job_id)
    .eq("employee_id", input.employee_id)
    .eq("work_date", input.work_date)
    .maybeSingle();

  if (input.hours <= 0) {
    if (existing) {
      await sb.from("commercial_assignments").delete().eq("id", (existing as { id: string }).id);
      await logDelete("commercial_assignments", (existing as { id: string }).id, existing, input.actor_user_id);
    }
    return { ok: true, assignmentId: null };
  }

  if (existing) {
    const { data, error } = await sb
      .from("commercial_assignments")
      .update({ scheduled_hours: input.hours, status: "planned", updated_at: new Date().toISOString() })
      .eq("id", (existing as { id: string }).id)
      .select("*")
      .single();
    if (error) return { ok: false, error: error.message };
    await logUpdate("commercial_assignments", (data as { id: string }).id, existing, data, input.actor_user_id);
    return { ok: true, assignmentId: (data as { id: string }).id };
  }

  const { data, error } = await sb
    .from("commercial_assignments")
    .insert({
      job_id: input.job_id,
      employee_id: input.employee_id,
      work_date: input.work_date,
      scheduled_hours: input.hours,
      status: "planned",
      created_by_user_id: input.actor_user_id,
    })
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  await logInsert("commercial_assignments", (data as { id: string }).id, data, input.actor_user_id);
  return { ok: true, assignmentId: (data as { id: string }).id };
}

/** Copy every assignment in a week forward 7 days. Skips a target cell that
 *  already has an assignment (never overwrites next week's real edits). */
export async function copyWeekForward(
  mondayIso: string,
  actorUserId: string
): Promise<{ ok: true; copied: number } | { ok: false; error: string }> {
  const start = mondayOf(mondayIso);
  const dates = Array.from({ length: 6 }, (_, i) => addDaysIso(start, i));
  const targetDates = dates.map((d) => addDaysIso(d, 7));
  const sb = commercialDb();

  const [srcRes, tgtRes] = await Promise.all([
    sb.from("commercial_assignments").select("job_id, employee_id, work_date, scheduled_hours, crew_id").in("work_date", dates).neq("status", "cancelled"),
    sb.from("commercial_assignments").select("job_id, employee_id, work_date").in("work_date", targetDates),
  ]);
  const src = (srcRes.data ?? []) as { job_id: string; employee_id: string; work_date: string; scheduled_hours: number; crew_id: string | null }[];
  const taken = new Set((tgtRes.data ?? []).map((t) => `${(t as { job_id: string }).job_id}|${(t as { employee_id: string }).employee_id}|${(t as { work_date: string }).work_date}`));

  const toInsert = src
    .map((a) => ({
      job_id: a.job_id,
      employee_id: a.employee_id,
      work_date: addDaysIso(a.work_date, 7),
      scheduled_hours: a.scheduled_hours,
      crew_id: a.crew_id,
      status: "planned" as const,
      created_by_user_id: actorUserId,
    }))
    .filter((a) => !taken.has(`${a.job_id}|${a.employee_id}|${a.work_date}`));

  if (toInsert.length === 0) return { ok: true, copied: 0 };
  const { data, error } = await sb.from("commercial_assignments").insert(toInsert).select("id");
  if (error) return { ok: false, error: error.message };
  return { ok: true, copied: (data ?? []).length };
}
