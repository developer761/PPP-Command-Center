import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate } from "@/lib/commercial/audit-log";

/**
 * The Foreman Daily Log — one painter, one day, under thirty seconds.
 *
 * Karan's spec (R10.4) is unusually specific about WHY, and it drives every
 * decision here: *"speed is the whole game — >30s and it won't happen daily,
 * regressing to 'every cell = 8'."* A daily log nobody fills in is worse than
 * none, because it looks like data.
 *
 * So the shape is: today arrives PRE-FILLED at the hours you were scheduled
 * for, and the common case is one tap. You only touch a number when the day
 * didn't go to plan.
 *
 * Four decisions worth stating:
 *
 * 1. **Per painter, not per crew.** Karan 2026-08-04. A foreman filling in six
 *    people's hours from memory at 5pm is how every cell becomes 8.
 *
 * 2. **Scheduled hours are the default, never the answer.** They are what was
 *    PLANNED. Submitting confirms them; the variance report exists precisely
 *    because plan and actual differ, and pre-filling is a convenience, not an
 *    assertion.
 *
 * 3. **Absence is a first-class answer.** "I wasn't there" needs to be as fast
 *    as "I was", or it gets recorded as zero hours worked — which reads as a
 *    painter who showed up and did nothing.
 *
 * 4. **Submitting locks the day, pending approval.** The entry goes in as
 *    `submitted`; a scheduler approves or questions it. Nobody edits their own
 *    hours after the fact, which is the whole point of an approval step.
 */

export type DailyLogJob = {
  assignmentId: string;
  jobId: string;
  jobName: string;
  jobCode: string | null;
  scheduledHours: number;
  /** What is already recorded for this job today, if anything. */
  enteredHours: number | null;
  entryStatus: string | null;
  /** True once it is past editing — approved or exported to payroll. */
  locked: boolean;
};

export type DailyLog = {
  workDate: string;
  jobs: DailyLogJob[];
  /** An absence already recorded for the day, if any. */
  absence: { type: string; hours: number | null } | null;
  /** Every job row settled — nothing left to submit. */
  allSubmitted: boolean;
  scheduledTotal: number;
};

export const ABSENCE_TYPES = [
  { value: "PTO", label: "Paid time off" },
  { value: "SICK", label: "Sick" },
  { value: "PERSONAL", label: "Personal" },
  { value: "HOLIDAY", label: "Holiday" },
  { value: "NO_WORK", label: "No work available" },
  { value: "NOT_AVAILABLE", label: "Not available" },
] as const;

/** Approved or exported — past the point where a painter may edit. */
const SETTLED = new Set(["approved", "exported"]);

export async function getDailyLog(
  employeeId: string,
  workDate: string
): Promise<DailyLog> {
  const sb = commercialDb();

  // Only PUBLISHED assignments. A planned-but-unpublished shift is a
  // scheduler's draft — showing it would ask a painter to confirm hours for
  // work nobody has told them about yet.
  const { data: assignRows } = await sb
    .from("commercial_assignments")
    .select("id, job_id, scheduled_hours")
    .eq("employee_id", employeeId)
    .eq("work_date", workDate)
    .eq("status", "published");
  const assignments = (assignRows ?? []) as { id: string; job_id: string; scheduled_hours: number }[];

  const [{ data: entryRows }, { data: absenceRows }] = await Promise.all([
    sb
      .from("commercial_time_entries")
      .select("job_id, actual_hours, status")
      .eq("employee_id", employeeId)
      .eq("work_date", workDate),
    sb
      .from("commercial_absences")
      .select("type, hours")
      .eq("employee_id", employeeId)
      .eq("work_date", workDate)
      .limit(1),
  ]);
  const entries = new Map(
    ((entryRows ?? []) as { job_id: string; actual_hours: number; status: string }[]).map((e) => [
      e.job_id,
      e,
    ])
  );

  // Jobs the painter worked but wasn't scheduled on show up too — the
  // "unplanned job" case in the spec. Without this, hours recorded against an
  // unscheduled job would be invisible on the very screen meant to confirm them.
  const jobIds = [...new Set([...assignments.map((a) => a.job_id), ...entries.keys()])];
  const jobMeta = new Map<string, { name: string; code: string | null }>();
  if (jobIds.length > 0) {
    const { data } = await sb
      .from("commercial_jobs")
      .select("id, name, job_code")
      .in("id", jobIds);
    for (const j of (data ?? []) as { id: string; name: string | null; job_code: string | null }[]) {
      jobMeta.set(j.id, { name: j.name?.trim() || j.job_code || "Untitled job", code: j.job_code });
    }
  }

  const byJob = new Map<string, DailyLogJob>();
  for (const a of assignments) {
    const e = entries.get(a.job_id);
    byJob.set(a.job_id, {
      assignmentId: a.id,
      jobId: a.job_id,
      jobName: jobMeta.get(a.job_id)?.name ?? "Untitled job",
      jobCode: jobMeta.get(a.job_id)?.code ?? null,
      scheduledHours: Number(a.scheduled_hours) || 0,
      enteredHours: e ? Number(e.actual_hours) : null,
      entryStatus: e?.status ?? null,
      locked: e ? SETTLED.has(e.status) : false,
    });
  }
  for (const [jobId, e] of entries) {
    if (byJob.has(jobId)) continue;
    byJob.set(jobId, {
      assignmentId: "",
      jobId,
      jobName: jobMeta.get(jobId)?.name ?? "Untitled job",
      jobCode: jobMeta.get(jobId)?.code ?? null,
      scheduledHours: 0, // unscheduled — worked anyway
      enteredHours: Number(e.actual_hours),
      entryStatus: e.status,
      locked: SETTLED.has(e.status),
    });
  }

  const jobs = [...byJob.values()].sort((a, b) => a.jobName.localeCompare(b.jobName));
  const absence = (absenceRows ?? [])[0] as { type: string; hours: number | null } | undefined;

  return {
    workDate,
    jobs,
    absence: absence ? { type: absence.type, hours: absence.hours } : null,
    allSubmitted: jobs.length > 0 && jobs.every((j) => j.entryStatus !== null),
    scheduledTotal: jobs.reduce((n, j) => n + j.scheduledHours, 0),
  };
}

/**
 * Record hours for one job on one day.
 *
 * Upsert on (employee, job, date) — the table's own unique key — because a
 * painter tapping Submit twice is a slow connection, not a second day's work.
 * Refuses once the entry is settled: approved hours are payroll, and the
 * approval step means nothing if the person can revise afterwards.
 */
export async function submitDailyHours(input: {
  employeeId: string;
  jobId: string;
  workDate: string;
  hours: number;
  actorUserId: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const hours = Number(input.hours);
  if (!Number.isFinite(hours) || hours < 0) return { ok: false, error: "Hours must be a number." };
  // A 24-hour day is a typo, not a shift. Capped rather than rejected — the
  // point is to record what happened, and refusing outright at 5pm on site is
  // how a day goes unrecorded entirely.
  const clamped = Math.min(24, Math.round(hours * 10) / 10);

  const sb = commercialDb();
  const { data: existing } = await sb
    .from("commercial_time_entries")
    .select("id, status, actual_hours")
    .eq("employee_id", input.employeeId)
    .eq("job_id", input.jobId)
    .eq("work_date", input.workDate)
    .maybeSingle();
  const prev = existing as { id: string; status: string; actual_hours: number } | null;

  if (prev && SETTLED.has(prev.status)) {
    return {
      ok: false,
      error: "Those hours have already been approved. Ask your scheduler to change them.",
    };
  }

  if (prev) {
    const patch = { actual_hours: clamped, status: "submitted", source: "manual" };
    const { error } = await sb.from("commercial_time_entries").update(patch).eq("id", prev.id);
    if (error) return { ok: false, error: error.message };
    await logUpdate("commercial_time_entries", prev.id, prev as unknown as Record<string, unknown>, patch, input.actorUserId).catch(() => undefined);
    return { ok: true };
  }

  const row = {
    employee_id: input.employeeId,
    job_id: input.jobId,
    work_date: input.workDate,
    actual_hours: clamped,
    status: "submitted",
    source: "manual",
  };
  const { data: created, error } = await sb
    .from("commercial_time_entries")
    .insert(row)
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  await logInsert("commercial_time_entries", (created as { id: string }).id, row, input.actorUserId).catch(() => undefined);
  return { ok: true };
}

/**
 * "I wasn't there today."
 *
 * Recorded as an absence rather than zero hours, because zero hours on a job
 * reads as a painter who turned up and did nothing. One row per day — picking
 * a second reason replaces the first rather than stacking.
 */
export async function submitDailyAbsence(input: {
  employeeId: string;
  workDate: string;
  type: string;
  actorUserId: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!ABSENCE_TYPES.some((t) => t.value === input.type)) {
    return { ok: false, error: "Pick a reason." };
  }
  const sb = commercialDb();
  const { data: existing } = await sb
    .from("commercial_absences")
    .select("id")
    .eq("employee_id", input.employeeId)
    .eq("work_date", input.workDate)
    .maybeSingle();

  if (existing) {
    const id = (existing as { id: string }).id;
    const { error } = await sb.from("commercial_absences").update({ type: input.type }).eq("id", id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }
  const row = { employee_id: input.employeeId, work_date: input.workDate, type: input.type };
  const { data: created, error } = await sb
    .from("commercial_absences")
    .insert(row)
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  await logInsert("commercial_absences", (created as { id: string }).id, row, input.actorUserId).catch(() => undefined);
  return { ok: true };
}
