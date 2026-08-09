import "server-only";

import { commercialDb } from "@/lib/commercial/db";
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

  const [assignRes, entryRes, jobRes, empRes, apprRes, horizonAssignRes] = await Promise.all([
    sb
      .from("commercial_assignments")
      .select("employee_id, job_id, work_date, scheduled_hours")
      .gte("work_date", weekStart)
      .lte("work_date", weekEnd)
      .neq("status", "cancelled"),
    sb
      .from("commercial_time_entries")
      .select("actual_hours, status, work_date")
      .gte("work_date", weekStart)
      .lte("work_date", weekEnd),
    sb.from("commercial_jobs").select("id, status").is("deleted_at", null),
    sb.from("commercial_employees").select("id, display_name").eq("active", true),
    sb.from("commercial_time_entries").select("id", { count: "exact", head: true }).in("status", ["submitted", "questioned"]),
    sb
      .from("commercial_assignments")
      .select("job_id")
      .gte("work_date", today)
      .lte("work_date", horizon)
      .neq("status", "cancelled"),
  ]);

  const assigns = (assignRes.data ?? []) as { employee_id: string; job_id: string; work_date: string; scheduled_hours: number }[];
  const entries = (entryRes.data ?? []) as { actual_hours: number; status: string; work_date: string }[];
  const jobs = (jobRes.data ?? []) as { id: string; status: string }[];
  const empName = new Map((empRes.data ?? []).map((r) => [(r as { id: string }).id, (r as { display_name: string }).display_name]));

  // Scheduled hours + per-employee totals (OT forecast) + distinct crew this week.
  const perEmp = new Map<string, number>();
  const crewWeek = new Set<string>();
  let scheduledHoursWeek = 0;
  const crewToday = new Set<string>();
  const jobsTodaySet = new Set<string>();
  for (const a of assigns) {
    scheduledHoursWeek += a.scheduled_hours;
    perEmp.set(a.employee_id, (perEmp.get(a.employee_id) ?? 0) + a.scheduled_hours);
    crewWeek.add(a.employee_id);
    if (a.work_date === today) {
      crewToday.add(a.employee_id);
      jobsTodaySet.add(a.job_id);
    }
  }

  const otForecast: OtRow[] = [...perEmp.entries()]
    .filter(([, h]) => h > OT_WEEK_HOURS)
    .map(([employee_id, scheduled]) => ({ employee_id, name: empName.get(employee_id) ?? "(crew)", scheduled: Math.round(scheduled * 4) / 4 }))
    .sort((a, b) => b.scheduled - a.scheduled);

  let clockedHoursWeek = 0;
  let approvedHoursWeek = 0;
  for (const e of entries) {
    clockedHoursWeek += e.actual_hours;
    if (e.status === "approved" || e.status === "exported") approvedHoursWeek += e.actual_hours;
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
