import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { mondayOf, addDaysIso, todayEtIso } from "./schedule";

/**
 * R10.7 Field Ops Overview KPIs. All numbers line up with the rest of the
 * platform: hours come from the same commercial_assignments (scheduled) and
 * commercial_time_entries (clocked/approved) that Payroll and the deal P&L read,
 * and the OT forecast uses the same Monday-anchored week as the payroll split.
 */

export type OtRow = { employee_id: string; name: string; scheduled: number };

export type FieldOpsOverview = {
  weekStart: string; // Monday
  scheduledHoursWeek: number;
  clockedHoursWeek: number;
  approvedHoursWeek: number;
  crewScheduledWeek: number;
  crewOnToday: number;
  jobsToday: number;
  jobsInProgress: number;
  readyToSchedule: number;
  pendingApprovals: number;
  unscheduledOpenJobs: number;
  otForecast: OtRow[]; // scheduled > 40h this week (OT risk)
};

const OT_WEEK_HOURS = 40;
const OPEN_STATUSES = ["estimating", "ready_to_schedule", "scheduled", "in_progress", "almost_done", "on_hold"];

export async function getFieldOpsOverview(): Promise<FieldOpsOverview> {
  const sb = commercialDb();
  const today = todayEtIso();
  const weekStart = mondayOf(today);
  const weekDates = Array.from({ length: 7 }, (_, i) => addDaysIso(weekStart, i)); // Mon-Sun
  const weekEnd = weekDates[6];
  const horizon = addDaysIso(today, 13); // next 14 days for "unscheduled" backlog

  const [assignRes, entryRes, jobs, empRes, apprRes, horizonAssignRes, absRes] = await Promise.all([
    sb
      .from("commercial_assignments")
      .select("employee_id, job_id, work_date, scheduled_hours")
      .gte("work_date", weekStart)
      .lte("work_date", weekEnd)
      .neq("status", "cancelled"),
    sb
      .from("commercial_time_entries")
      .select("employee_id, job_id, actual_hours, status, work_date")
      .gte("work_date", weekStart)
      .lte("work_date", weekEnd),
    // Paginated — commercial_jobs grows unbounded over time; a 1000-row truncation
    // would undercount jobsInProgress / readyToSchedule (audit round 14).
    paginateAll<{ id: string; status: string }>(() => sb.from("commercial_jobs").select("id, status").is("deleted_at", null).order("id")),
    sb.from("commercial_employees").select("id, display_name, worker_type"),
    sb.from("commercial_time_entries").select("id", { count: "exact", head: true }).in("status", ["submitted", "questioned"]),
    sb
      .from("commercial_assignments")
      .select("job_id")
      .gte("work_date", today)
      .lte("work_date", horizon)
      .neq("status", "cancelled"),
    sb
      .from("commercial_absences")
      .select("employee_id, work_date, hours")
      .gte("work_date", weekStart)
      .lte("work_date", weekEnd),
  ]);

  const assigns = (assignRes.data ?? []) as { employee_id: string; job_id: string; work_date: string; scheduled_hours: number }[];
  const entries = (entryRes.data ?? []) as { employee_id: string; job_id: string; actual_hours: number; status: string; work_date: string }[];
  const empName = new Map((empRes.data ?? []).map((r) => [(r as { id: string }).id, (r as { display_name: string }).display_name]));
  const w2Emp = new Set(((empRes.data ?? []) as { id: string; worker_type: string }[]).filter((r) => r.worker_type === "w2").map((r) => r.id));

  // Scheduled hours + per-employee totals (OT forecast) + distinct crew this week.
  // Drop assignments whose work order was soft-deleted — the Calendar already
  // excludes them (getMonthOverview), so counting them here made the two surfaces
  // disagree (audit round 7).
  const liveJobIds = new Set(jobs.map((j) => j.id));
  // Marked-off crew: a full-day absence (hours == null) zeroes that day's
  // scheduled hours; a partial (hours set) subtracts those hours. So the hours
  // KPIs + OT forecast reflect time off instead of counting hours nobody will
  // work (Karan 2026-08). crewWeek/crewToday still count who's on the schedule.
  const absences = (absRes.data ?? []) as { employee_id: string; work_date: string; hours: number | null }[];
  const fullOff = new Set<string>();
  const partialOff = new Map<string, number>();
  for (const ab of absences) {
    const key = `${ab.employee_id}|${String(ab.work_date).slice(0, 10)}`;
    if (ab.hours == null) fullOff.add(key);
    else partialOff.set(key, (partialOff.get(key) ?? 0) + Number(ab.hours));
  }
  const crewWeek = new Set<string>();
  const crewToday = new Set<string>();
  const jobsTodaySet = new Set<string>();
  const schedByEmpDate = new Map<string, number>(); // `${emp}|${date}` → scheduled
  for (const a of assigns) {
    if (!liveJobIds.has(a.job_id)) continue;
    schedByEmpDate.set(`${a.employee_id}|${a.work_date}`, (schedByEmpDate.get(`${a.employee_id}|${a.work_date}`) ?? 0) + a.scheduled_hours);
    crewWeek.add(a.employee_id);
    // "On today" excludes anyone fully marked off today — they're on the schedule
    // (crewWeek) but not actually working today (audit 2026-08, low-pri).
    if (a.work_date === today && !fullOff.has(`${a.employee_id}|${today}`)) {
      crewToday.add(a.employee_id);
      jobsTodaySet.add(a.job_id);
    }
  }
  // Apply absences per (employee, day), then aggregate.
  const perEmp = new Map<string, number>();
  let scheduledHoursWeek = 0;
  for (const [key, sched] of schedByEmpDate) {
    const eff = fullOff.has(key) ? 0 : partialOff.has(key) ? Math.max(0, sched - partialOff.get(key)!) : sched;
    if (eff <= 0) continue;
    scheduledHoursWeek += eff;
    const emp = key.slice(0, key.indexOf("|"));
    perEmp.set(emp, (perEmp.get(emp) ?? 0) + eff);
  }

  const otForecast: OtRow[] = [...perEmp.entries()]
    .filter(([, h]) => h > OT_WEEK_HOURS)
    .map(([employee_id, scheduled]) => ({ employee_id, name: empName.get(employee_id) ?? "(crew)", scheduled: Math.round(scheduled * 4) / 4 }))
    .sort((a, b) => b.scheduled - a.scheduled);

  // Count EVERY in-week entry (incl. soft-deleted-job hours) so clocked/approved
  // reconcile with Payroll + Hours Log, which pay/count worked hours regardless of
  // the job's deleted_at (audit round 13). Only "approved (ready for payroll)" is
  // W-2, matching what Payroll pays. The liveJobIds gate stays on SCHEDULED hours
  // above — that one exists to match the Calendar, a separate invariant.
  let clockedHoursWeek = 0;
  let approvedHoursWeek = 0;
  for (const e of entries) {
    clockedHoursWeek += e.actual_hours;
    if ((e.status === "approved" || e.status === "exported") && w2Emp.has(e.employee_id)) approvedHoursWeek += e.actual_hours;
  }

  const jobsInProgress = jobs.filter((j) => j.status === "in_progress").length;
  const readyToSchedule = jobs.filter((j) => j.status === "ready_to_schedule").length;

  const scheduledJobIds = new Set((horizonAssignRes.data ?? []).map((r) => (r as { job_id: string }).job_id));
  const unscheduledOpenJobs = jobs.filter((j) => OPEN_STATUSES.includes(j.status) && !scheduledJobIds.has(j.id)).length;

  const round = (n: number) => Math.round(n * 4) / 4;

  return {
    weekStart,
    scheduledHoursWeek: round(scheduledHoursWeek),
    clockedHoursWeek: round(clockedHoursWeek),
    approvedHoursWeek: round(approvedHoursWeek),
    crewScheduledWeek: crewWeek.size,
    crewOnToday: crewToday.size,
    jobsToday: jobsTodaySet.size,
    jobsInProgress,
    readyToSchedule,
    pendingApprovals: apprRes.count ?? 0,
    unscheduledOpenJobs,
    otForecast,
  };
}
