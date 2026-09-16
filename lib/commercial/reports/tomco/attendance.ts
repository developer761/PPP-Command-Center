import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import type { ReportSpec } from "@/lib/commercial/reports/grouped/spec";

/**
 * "Tomco Attendance" — who was on site, where, and for how long.
 *
 * THIS IS THE REPORT THAT MAKES THE HOURS VISIBLE AGAIN.
 *
 * Every one of Tomco's 23 crew is a subcontractor: they are paid through labor
 * companies, and that money is already booked against the job as a Subcontract
 * cost — $547,977.26 of it. So the platform's labor-COST surfaces exclude them
 * on purpose, because counting both would charge every job twice. The
 * side-effect was that 14,992 hours of real work existed nowhere on screen, and
 * Labor & Payroll read "no approved hours" at every date range, which looks
 * like a failed import rather than a deliberate split.
 *
 * Mary's own Salesforce report is the answer to that, and it is the shape used
 * here: hours and labor days per crew per job, with NO cost column at all.
 * Hours are a record of who was on site; the money lives in the payouts. Both
 * are true, and neither is double-counted.
 *
 * Her printed figures, for the shape: 47 records · 407.5 hours · 50.95 labor
 * days, with Omar LI at 99.5 hours over 12.44 days.
 */

export type AttendanceRow = {
  id: string;
  crew: string;
  jobName: string;
  oppId: string | null;
  ymd: string;
  hours: number;
  /** Salesforce's "Labor Days" — an 8-hour day. */
  days: number;
};

const HOURS_PER_DAY = 8;

export async function getAttendanceRows(): Promise<AttendanceRow[]> {
  const sb = commercialDb();

  const entries = await paginateAll<{
    id: string;
    employee_id: string;
    job_id: string;
    work_date: string;
    actual_hours: number;
    status: string;
  }>(() =>
    sb
      .from("commercial_time_entries")
      .select("id, employee_id, job_id, work_date, actual_hours, status")
      .order("id", { ascending: true })
  );
  if (entries.length === 0) return [];

  const [employees, jobs] = await Promise.all([
    paginateAll<{ id: string; display_name: string | null; first_name: string | null; last_name: string | null }>(() =>
      sb
        .from("commercial_employees")
        .select("id, display_name, first_name, last_name")
        .in("id", [...new Set(entries.map((e) => e.employee_id))])
        .order("id", { ascending: true })
    ),
    paginateAll<{ id: string; name: string | null; opportunity_id: string | null }>(() =>
      sb
        .from("commercial_jobs")
        .select("id, name, opportunity_id")
        .in("id", [...new Set(entries.map((e) => e.job_id))])
        .order("id", { ascending: true })
    ),
  ]);

  const crewOf = new Map(
    employees.map((e) => [
      e.id,
      (e.display_name ?? "").trim() || [e.first_name, e.last_name].filter(Boolean).join(" ") || "Crew",
    ])
  );
  const jobOf = new Map(jobs.map((j) => [j.id, j]));

  return entries.map((e) => {
    const hours = Number(e.actual_hours) || 0;
    const job = jobOf.get(e.job_id);
    return {
      id: e.id,
      crew: crewOf.get(e.employee_id) ?? "Crew",
      jobName: (job?.name ?? "").trim() || "—",
      oppId: job?.opportunity_id ?? null,
      ymd: String(e.work_date).slice(0, 10),
      hours,
      // Two decimals, like Salesforce prints it (7.75 days, 12.44 days).
      days: Math.round((hours / HOURS_PER_DAY) * 100) / 100,
    };
  });
}

export const ATTENDANCE_SPEC: ReportSpec<AttendanceRow> = {
  title: "Attendance",
  sourceLabel: "Work Orders with Attendance",
  blurb:
    "Who was on site, on which job, for how long. Hours only — what the crews COST is on the job's Subcontract lines, so nothing is counted twice.",
  totals: [
    { label: "Total hours worked", kind: "hours", value: (rows) => rows.reduce((n, r) => n + r.hours, 0) },
    { label: "Total labor days", kind: "number", value: (rows) => rows.reduce((n, r) => n + r.days, 0) },
  ],
  groupings: [
    [
      { key: "crew", label: "Labor crew", of: (r) => r.crew },
      { key: "job", label: "Job", of: (r) => r.jobName },
    ],
    [
      { key: "job", label: "Job", of: (r) => r.jobName },
      { key: "crew", label: "Labor crew", of: (r) => r.crew },
    ],
    [{ key: "month", label: "Month", of: (r) => r.ymd.slice(0, 7) }],
  ],
  columns: [
    { key: "job", label: "Name", text: (r) => r.jobName, href: (r) => (r.oppId ? `/commercial/opportunities/${r.oppId}` : null) },
    { key: "date", label: "Date", text: (r) => r.ymd },
    { key: "hours", label: "Hours worked", kind: "hours", amount: (r) => r.hours },
    { key: "days", label: "Labor days", kind: "number", amount: (r) => r.days, secondary: true },
  ],
};
