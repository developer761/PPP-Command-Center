import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { mondayOf, addDaysIso, todayEtIso } from "./schedule";
import { listPendingApprovals } from "./approvals";

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
  /** The slice of the above that the payroll export will actually carry (W-2 only). */
  approvedPayrollHoursWeek: number;
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

/**
 * The week's hours, split three ways. Pure so the rule below is testable.
 *
 * Counts EVERY in-week entry, soft-deleted-job hours included, so clocked and
 * approved reconcile with Payroll and the Hours Log — both of which count
 * worked hours regardless of the job's `deleted_at` (audit round 13). The
 * `liveJobIds` gate stays on SCHEDULED hours only; that one exists to match the
 * Calendar, a separate invariant.
 *
 * APPROVED COUNTS EVERYBODY. It used to be W-2 only, "matching what Payroll
 * pays", and for Tomco that pinned the tile at 0h forever: all 23 of their crew
 * are `worker_type = 'sub'` — they pay crews through labor companies, not
 * payroll — so 760 approved hours since 2026-09-01 displayed as zero. Worse,
 * the "Time to review" count two tiles away has no W-2 filter, so Mary could
 * clear forty sub entries out of the review queue and watch "Approved this
 * week" stay on zero. Approval is an ATTENDANCE sign-off; it means the same
 * thing for a sub as for a W-2.
 *
 * What IS genuinely W-2-only is the payroll export, so that figure is carried
 * separately for the tile's caption instead of silently deciding the headline.
 */
export function splitWeekHours(
  entries: { employee_id: string; actual_hours: number; status: string }[],
  w2EmployeeIds: ReadonlySet<string>,
): { clocked: number; approved: number; approvedPayroll: number } {
  let clocked = 0;
  let approved = 0;
  let approvedPayroll = 0;
  for (const e of entries) {
    clocked += e.actual_hours;
    if (e.status === "approved" || e.status === "exported") {
      approved += e.actual_hours;
      if (w2EmployeeIds.has(e.employee_id)) approvedPayroll += e.actual_hours;
    }
  }
  return { clocked, approved, approvedPayroll };
}

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
    /**
     * THE SAME QUEUE THE APPROVALS PAGE SHOWS, not a raw status count.
     *
     * This counted every submitted/questioned row. The approvals page drops
     * empty entries belonging to deactivated people — 0h rows on the
     * "(old company entry)" duplicates the Salesforce migration left behind —
     * and its docblock explains at length why they are not work to review.
     *
     * Only one side of that seam was updated. So Field Ops Overview said
     * "Time to review 9 →", the page it links to showed ONE, and eight of the
     * nine could never be cleared by anyone: 0-hour entries against employees
     * who no longer exist. A permanent amber counter that resolves to nothing
     * is how people stop believing every other number on the page.
     *
     * Counting the list itself rather than re-expressing its rule — the rule
     * needs a join PostgREST cannot do in one query, and a second copy of it
     * is what produced this in the first place.
     */
    listPendingApprovals().then((rows) => ({ count: rows.length })),
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

  const { clocked: clockedHoursWeek, approved: approvedHoursWeek, approvedPayroll: approvedPayrollHoursWeek } = splitWeekHours(entries, w2Emp);

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
    approvedPayrollHoursWeek: round(approvedPayrollHoursWeek),
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
