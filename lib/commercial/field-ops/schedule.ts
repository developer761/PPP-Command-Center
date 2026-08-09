import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";
import type { JobStatus } from "./job-constants";

/**
 * R10.7 Scheduling core — powers the interactive Calendar (the one scheduling
 * surface). Scheduled hours = commercial_assignments; actuals = time_entries.
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

/** Milliseconds to add to a UTC instant to reach America/New_York wall time
 *  (negative — e.g. -4h in EDT, -5h in EST). DST-correct at the given instant. */
function etOffsetMs(at: Date): number {
  const utc = new Date(at.toLocaleString("en-US", { timeZone: "UTC" }));
  const et = new Date(at.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return et.getTime() - utc.getTime();
}

/**
 * The UTC instant of a wall-clock time in America/New_York on a given date.
 * `dateIso` = YYYY-MM-DD, `timeStr` = "HH:MM" or "HH:MM:SS". DST-correct.
 * Used to schedule the "10 min before shift" clock-in email at the right moment.
 */
export function etWallTimeToUtcIso(dateIso: string, timeStr: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(timeStr ?? "");
  if (!m) return null;
  const [y, mo, d] = dateIso.split("-").map(Number);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  const off = etOffsetMs(new Date(guess));
  return new Date(guess - off).toISOString();
}

/** "07:00:00" / "07:00" -> "7:00 AM". Blank -> null. */
export function fmtTime12(t: string | null | undefined): string | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(t ?? "");
  if (!m) return null;
  let h = Number(m[1]);
  const mm = m[2];
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${mm} ${ap}`;
}

/** Whole/quarter hours between two "HH:MM" times, or null if unusable. */
export function hoursBetween(start: string | null | undefined, end: string | null | undefined): number | null {
  const ms = /^(\d{1,2}):(\d{2})/.exec(start ?? "");
  const me = /^(\d{1,2}):(\d{2})/.exec(end ?? "");
  if (!ms || !me) return null;
  const s = Number(ms[1]) * 60 + Number(ms[2]);
  const e = Number(me[1]) * 60 + Number(me[2]);
  if (e <= s) return null;
  return Math.round(((e - s) / 60) * 4) / 4;
}

/** First day of the month containing `iso`, as YYYY-MM-01. */
export function monthStartOf(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/** One crew member's shift on a day, for the calendar cell + agenda. */
export type DayCrew = {
  employee_id: string;
  name: string;
  start: string | null; // "HH:MM:SS"
  end: string | null;
  hours: number;
  job_id: string;
  job_name: string;
  job_status: JobStatus;
  prevailing_wage: boolean;
};

export type DayOff = { id: string; employee_id: string; name: string; type: string; short: string };

export type MonthDay = {
  date: string;
  inMonth: boolean;
  crew: DayCrew[]; // who's scheduled, sorted by start time
  headcount: number;
  hours: number;
  off: DayOff[]; // who's marked absent (PTO/Sick/…) that day
};

/**
 * Month overview for the Calendar. Returns a full 6-week grid (Sun-start) so the
 * calendar always renders clean. Each day carries the crew scheduled (name +
 * times + work order) so the cells show PEOPLE, not just jobs. Shifts whose work
 * order was soft-deleted are dropped. `inMonth` flags adjacent-month days.
 */
export async function getMonthOverview(anyDateIso: string): Promise<{ monthStart: string; grid: MonthDay[] }> {
  const monthStart = monthStartOf(anyDateIso);
  const [y, m] = monthStart.split("-").map(Number);
  // Grid starts on the Sunday on/before the 1st, runs 42 days (6 weeks).
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); // 0=Sun
  const gridStart = addDaysIso(monthStart, -firstDow);
  const dates = Array.from({ length: 42 }, (_, i) => addDaysIso(gridStart, i));

  const sb = commercialDb();
  const { getAbsencesForRange, absenceShort } = await import("./absences");
  const absencesByDate = await getAbsencesForRange(dates[0], dates[41]);
  const { data: aRows } = await sb
    .from("commercial_assignments")
    .select("job_id, employee_id, work_date, scheduled_hours, scheduled_start_time, scheduled_end_time")
    .gte("work_date", dates[0])
    .lte("work_date", dates[41])
    .neq("status", "cancelled");
  const assignments = (aRows ?? []) as {
    job_id: string; employee_id: string; work_date: string; scheduled_hours: number;
    scheduled_start_time: string | null; scheduled_end_time: string | null;
  }[];

  const jobIds = [...new Set(assignments.map((a) => a.job_id))];
  const empIds = [...new Set(assignments.map((a) => a.employee_id))];
  const jobsById = new Map<string, { id: string; name: string; status: JobStatus; prevailing_wage: boolean }>();
  const empName = new Map<string, string>();
  await Promise.all([
    jobIds.length > 0
      ? sb.from("commercial_jobs").select("id, name, status, prevailing_wage").in("id", jobIds).is("deleted_at", null).then(({ data }) => {
          for (const j of (data ?? []) as { id: string; name: string; status: JobStatus; prevailing_wage: boolean }[]) jobsById.set(j.id, j);
        })
      : Promise.resolve(),
    empIds.length > 0
      ? sb.from("commercial_employees").select("id, display_name").in("id", empIds).then(({ data }) => {
          for (const e of (data ?? []) as { id: string; display_name: string }[]) empName.set(e.id, e.display_name);
        })
      : Promise.resolve(),
  ]);

  const monthPrefix = monthStart.slice(0, 7);
  const grid: MonthDay[] = dates.map((date) => {
    const crew: DayCrew[] = [];
    const emps = new Set<string>();
    let hours = 0;
    for (const a of assignments.filter((x) => x.work_date === date)) {
      const meta = jobsById.get(a.job_id);
      if (!meta) continue; // work order was deleted
      crew.push({
        employee_id: a.employee_id,
        name: empName.get(a.employee_id) ?? "(crew)",
        start: a.scheduled_start_time,
        end: a.scheduled_end_time,
        hours: a.scheduled_hours,
        job_id: a.job_id,
        job_name: meta.name,
        job_status: meta.status,
        prevailing_wage: meta.prevailing_wage,
      });
      emps.add(a.employee_id);
      hours += a.scheduled_hours;
    }
    crew.sort((x, y2) => (x.start ?? "99:99").localeCompare(y2.start ?? "99:99") || x.name.localeCompare(y2.name));
    const off: DayOff[] = (absencesByDate.get(date) ?? []).map((a) => ({
      id: a.id,
      employee_id: a.employee_id,
      name: a.employee_name,
      type: a.type,
      short: absenceShort(a.type),
    }));
    return {
      date,
      inMonth: date.slice(0, 7) === monthPrefix,
      crew,
      headcount: emps.size,
      hours,
      off,
    };
  });

  return { monthStart, grid };
}

/* ── R10.7 Interactive Calendar — a day's assignments + rich upsert ────────── */

export type DayAssignment = {
  assignment_id: string;
  employee_id: string;
  employee_name: string;
  job_id: string;
  job_name: string;
  job_code: string;
  job_status: JobStatus;
  prevailing_wage: boolean;
  site: string | null;
  scheduled_hours: number;
  start_time: string | null; // "HH:MM:SS"
  end_time: string | null;
  note: string | null;
};

/** Everyone scheduled on one date, with their job + times + note. Sorted by
 *  start time (unset last), then crew name. Powers the Calendar day panel. */
export async function getDaySchedule(dateIso: string): Promise<DayAssignment[]> {
  const sb = commercialDb();
  const { data: aRows } = await sb
    .from("commercial_assignments")
    .select("id, job_id, employee_id, scheduled_hours, scheduled_start_time, scheduled_end_time, note")
    .eq("work_date", dateIso)
    .neq("status", "cancelled");
  const assigns = (aRows ?? []) as {
    id: string; job_id: string; employee_id: string; scheduled_hours: number;
    scheduled_start_time: string | null; scheduled_end_time: string | null; note: string | null;
  }[];
  if (assigns.length === 0) return [];

  const empIds = [...new Set(assigns.map((a) => a.employee_id))];
  const jobIds = [...new Set(assigns.map((a) => a.job_id))];
  const [empRes, jobRes] = await Promise.all([
    sb.from("commercial_employees").select("id, display_name").in("id", empIds),
    sb.from("commercial_jobs").select("id, name, job_code, status, prevailing_wage, site_address, site_city").in("id", jobIds).is("deleted_at", null),
  ]);
  const empName = new Map((empRes.data ?? []).map((r) => [(r as { id: string }).id, (r as { display_name: string }).display_name]));
  const jobsById = new Map(
    (jobRes.data ?? []).map((r) => {
      const j = r as { id: string; name: string; job_code: string; status: JobStatus; prevailing_wage: boolean; site_address: string | null; site_city: string | null };
      return [j.id, j];
    })
  );

  return assigns
    .filter((a) => jobsById.has(a.job_id)) // drop shifts whose work order was deleted
    .map((a): DayAssignment => {
      const j = jobsById.get(a.job_id);
      return {
        assignment_id: a.id,
        employee_id: a.employee_id,
        employee_name: empName.get(a.employee_id) ?? "(crew)",
        job_id: a.job_id,
        job_name: j?.name ?? "(work order)",
        job_code: j?.job_code ?? "",
        job_status: (j?.status ?? "ready_to_schedule") as JobStatus,
        prevailing_wage: j?.prevailing_wage ?? false,
        site: [j?.site_address, j?.site_city].filter(Boolean).join(", ") || null,
        scheduled_hours: a.scheduled_hours,
        start_time: a.scheduled_start_time,
        end_time: a.scheduled_end_time,
        note: a.note,
      };
    })
    .sort((x, y) => {
      const sx = x.start_time ?? "99:99";
      const sy = y.start_time ?? "99:99";
      return sx === sy ? x.employee_name.localeCompare(y.employee_name) : sx.localeCompare(sy);
    });
}

/**
 * Place (or update) one crew member on one work order for one day, with the
 * times they work + a note that flows into their email. Hours are derived from
 * start+end when both are given, else fall back to the provided hours / 8.
 * On success, emails the crew member their shift for that day (fire-and-forget)
 * and — if a start time is set — schedules their 10-min-before clock-in nudge.
 * Upsert on UNIQUE(job, employee, date).
 */
export async function upsertAssignment(input: {
  job_id: string;
  employee_id: string;
  work_date: string;
  start_time?: string | null;
  end_time?: string | null;
  hours?: number | null;
  note?: string | null;
  actor_user_id: string;
}): Promise<{ ok: true; assignmentId: string } | { ok: false; error: string }> {
  const sb = commercialDb();
  const start = (input.start_time ?? "").trim() || null;
  const end = (input.end_time ?? "").trim() || null;
  if (start && end && hoursBetween(start, end) == null) {
    return { ok: false, error: "End time must be after start time." };
  }
  const derived = start && end ? hoursBetween(start, end) : null;
  let hours = derived ?? (input.hours != null && Number.isFinite(input.hours) ? input.hours : 8);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) hours = 8;
  const note = (input.note ?? "").trim().slice(0, 500) || null;

  const { data: existing } = await sb
    .from("commercial_assignments")
    .select("*")
    .eq("job_id", input.job_id)
    .eq("employee_id", input.employee_id)
    .eq("work_date", input.work_date)
    .maybeSingle();

  const row = {
    scheduled_hours: hours,
    scheduled_start_time: start,
    scheduled_end_time: end,
    note,
    status: "planned" as const,
    updated_at: new Date().toISOString(),
  };

  let assignmentId: string;
  if (existing) {
    const { data, error } = await sb
      .from("commercial_assignments")
      .update(row)
      .eq("id", (existing as { id: string }).id)
      .select("*")
      .single();
    if (error) return { ok: false, error: error.message };
    await logUpdate("commercial_assignments", (data as { id: string }).id, existing, data, input.actor_user_id);
    assignmentId = (data as { id: string }).id;
  } else {
    const { data, error } = await sb
      .from("commercial_assignments")
      .insert({
        job_id: input.job_id,
        employee_id: input.employee_id,
        work_date: input.work_date,
        created_by_user_id: input.actor_user_id,
        ...row,
      })
      .select("*")
      .single();
    if (error) return { ok: false, error: error.message };
    await logInsert("commercial_assignments", (data as { id: string }).id, data, input.actor_user_id);
    assignmentId = (data as { id: string }).id;
  }

  // Email the crew member their shift (consolidated for the day) + schedule the
  // clock-in nudge. Dynamic import breaks the schedule ↔ email-send cycle.
  try {
    const { sendShiftAssignmentEmail } = await import("./schedule-email-send");
    await sendShiftAssignmentEmail(input.employee_id, input.work_date);
  } catch (err) {
    console.warn("[field-ops] shift assignment email failed:", err);
  }

  return { ok: true, assignmentId };
}

/**
 * Copy a whole week's schedule forward one week. Duplicates every non-cancelled
 * assignment in [sourceMonday .. +5] (Mon–Sat) to the same weekday next week.
 * Bulk, so it does NOT email — the scheduler reviews the copied week and any
 * edit re-notifies that person. Skips, never doubles or double-books:
 *   - a target shift that already exists (same job+person+day),
 *   - a person marked OFF (absence) on the target day,
 *   - a job that's been soft-deleted.
 * Returns counts so the UI can say exactly what happened.
 */
export async function copyWeekForward(
  sourceMondayIso: string,
  actorUserId: string,
): Promise<{ ok: true; copied: number; skippedExisting: number; skippedAbsent: number; skippedDeletedJob: number; targetMonday: string } | { ok: false; error: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceMondayIso)) return { ok: false, error: "Invalid week." };
  const srcMon = mondayOf(sourceMondayIso);
  const srcSun = addDaysIso(srcMon, 6); // full Mon–Sun week (Sunday is a real work day — PW crews)
  const tgtMon = addDaysIso(srcMon, 7);
  const tgtSun = addDaysIso(srcSun, 7);
  const sb = commercialDb();

  // Source week assignments (Mon–Sun, live).
  const { data: srcRows } = await sb
    .from("commercial_assignments")
    .select("job_id, employee_id, work_date, scheduled_hours, scheduled_start_time, scheduled_end_time, note")
    .gte("work_date", srcMon)
    .lte("work_date", srcSun)
    .neq("status", "cancelled");
  const src = (srcRows ?? []) as {
    job_id: string; employee_id: string; work_date: string; scheduled_hours: number;
    scheduled_start_time: string | null; scheduled_end_time: string | null; note: string | null;
  }[];
  if (src.length === 0) return { ok: true, copied: 0, skippedExisting: 0, skippedAbsent: 0, skippedDeletedJob: 0, targetMonday: tgtMon };

  // Target-week existing assignments (to dedup), absences (to skip), + live jobs.
  const [{ data: tgtRows }, { data: absRows }, { data: jobRows }] = await Promise.all([
    sb.from("commercial_assignments").select("job_id, employee_id, work_date").gte("work_date", tgtMon).lte("work_date", tgtSun).neq("status", "cancelled"),
    sb.from("commercial_absences").select("employee_id, work_date").gte("work_date", tgtMon).lte("work_date", tgtSun),
    sb.from("commercial_jobs").select("id").is("deleted_at", null).in("id", [...new Set(src.map((s) => s.job_id))]),
  ]);
  const existing = new Set(((tgtRows ?? []) as { job_id: string; employee_id: string; work_date: string }[]).map((r) => `${r.job_id}|${r.employee_id}|${String(r.work_date).slice(0, 10)}`));
  const absent = new Set(((absRows ?? []) as { employee_id: string; work_date: string }[]).map((r) => `${r.employee_id}|${String(r.work_date).slice(0, 10)}`));
  const liveJobs = new Set(((jobRows ?? []) as { id: string }[]).map((r) => r.id));

  let copied = 0, skippedExisting = 0, skippedAbsent = 0, skippedDeletedJob = 0;
  const toInsert: Record<string, unknown>[] = [];
  for (const s of src) {
    const tgtDate = addDaysIso(String(s.work_date).slice(0, 10), 7);
    if (!liveJobs.has(s.job_id)) { skippedDeletedJob += 1; continue; }
    if (existing.has(`${s.job_id}|${s.employee_id}|${tgtDate}`)) { skippedExisting += 1; continue; }
    if (absent.has(`${s.employee_id}|${tgtDate}`)) { skippedAbsent += 1; continue; }
    toInsert.push({
      job_id: s.job_id,
      employee_id: s.employee_id,
      work_date: tgtDate,
      scheduled_hours: s.scheduled_hours,
      scheduled_start_time: s.scheduled_start_time,
      scheduled_end_time: s.scheduled_end_time,
      note: s.note,
      status: "planned",
      created_by_user_id: actorUserId,
    });
  }

  if (toInsert.length > 0) {
    // upsert (not insert): a source row can collide with a CANCELLED target row
    // (a revived job's leftover) which the dedup query hides — a plain insert
    // would violate unique(job,emp,date) and abort the ENTIRE week. On conflict,
    // reactivate that row to 'planned' instead (audit round 2). Live planned
    // rows are already filtered into `existing`/skippedExisting, so they're never
    // in toInsert and can't be clobbered.
    const { data: inserted, error } = await sb
      .from("commercial_assignments")
      .upsert(toInsert, { onConflict: "job_id,employee_id,work_date" })
      .select("id");
    if (error) return { ok: false, error: error.message };
    copied = (inserted ?? []).length;
    for (const r of (inserted ?? []) as { id: string }[]) {
      await logInsert("commercial_assignments", r.id, { bulk: "copy_week_forward" }, actorUserId);
    }
  }
  return { ok: true, copied, skippedExisting, skippedAbsent, skippedDeletedJob, targetMonday: tgtMon };
}

/** Remove one assignment (by id). Used by the Calendar day panel. */
export async function deleteAssignmentById(
  assignmentId: string,
  actorUserId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: existing } = await sb.from("commercial_assignments").select("*").eq("id", assignmentId).maybeSingle();
  if (!existing) return { ok: true };
  const { error } = await sb.from("commercial_assignments").delete().eq("id", assignmentId);
  if (error) return { ok: false, error: error.message };
  await logDelete("commercial_assignments", assignmentId, existing, actorUserId);
  // Re-sync the queued 10-min clock-in nudge: cancel it, and if the crew member
  // still has ANOTHER shift that day, re-schedule it for the earliest remaining
  // start. A bare cancel would drop the nudge for a still-scheduled shift, and
  // the once-daily cron can't fix a same-day removal (audit 2026-08).
  const ex = existing as { employee_id?: string; work_date?: string };
  if (ex.employee_id && ex.work_date) {
    const { resyncClockReminder } = await import("./schedule-email-send");
    await resyncClockReminder(ex.employee_id, ex.work_date).catch(() => undefined);
  }
  return { ok: true };
}

