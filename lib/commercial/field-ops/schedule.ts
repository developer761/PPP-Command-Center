import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
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

/** Whole/quarter hours between two "HH:MM" times, or null if unusable.
 *  A night shift crosses midnight (e.g. 22:00 → 06:00): when the end is EARLIER
 *  than the start, the end is the next day, so add 24h — matching clock.ts,
 *  which measures elapsed span and already supports cross-midnight punches.
 *  Without this a night shift returned null and couldn't be scheduled at all
 *  (audit FO5). Equal times are still rejected (a 0-hour / ambiguous-24h shift). */
export function hoursBetween(start: string | null | undefined, end: string | null | undefined): number | null {
  const ms = /^(\d{1,2}):(\d{2})/.exec(start ?? "");
  const me = /^(\d{1,2}):(\d{2})/.exec(end ?? "");
  if (!ms || !me) return null;
  const s = Number(ms[1]) * 60 + Number(ms[2]);
  let e = Number(me[1]) * 60 + Number(me[2]);
  if (e === s) return null;
  if (e < s) e += 24 * 60; // crosses midnight — end is the next day
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
  // Paginated — the 42-day grid × full crew is the WIDEST assignment query in the
  // module and can exceed Supabase's silent 1000-row cap, which would silently
  // drop shifts (crew vanish from day cells, headcount understated) (audit round 6).
  const assignments = await paginateAll<{
    job_id: string; employee_id: string; work_date: string; scheduled_hours: number;
    scheduled_start_time: string | null; scheduled_end_time: string | null;
  }>(() =>
    sb
      .from("commercial_assignments")
      .select("job_id, employee_id, work_date, scheduled_hours, scheduled_start_time, scheduled_end_time")
      .gte("work_date", dates[0])
      .lte("work_date", dates[41])
      .neq("status", "cancelled")
      .order("work_date")
      .order("id")
  );

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
      // `active` is read so a person who has left is LABELLED rather than
      // silently present. Deactivation cancels future shifts, but assignments
      // written before that shipped are still on the calendar — and a manager
      // reading a name with no marker will dispatch them.
      ? sb.from("commercial_employees").select("id, display_name, active").in("id", empIds).then(({ data }) => {
          for (const e of (data ?? []) as { id: string; display_name: string; active: boolean }[]) {
            empName.set(e.id, e.active === false ? `${e.display_name} (inactive)` : e.display_name);
          }
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
    sb.from("commercial_employees").select("id, display_name, active").in("id", empIds),
    sb.from("commercial_jobs").select("id, name, job_code, status, prevailing_wage, site_address, site_city").in("id", jobIds).is("deleted_at", null),
  ]);
  const empName = new Map(
    (empRes.data ?? []).map((r) => {
      const e = r as { id: string; display_name: string; active: boolean };
      // See the note above: shown with a marker, not hidden.
      return [e.id, e.active === false ? `${e.display_name} (inactive)` : e.display_name];
    })
  );
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

  const { data: existing } = await sb
    .from("commercial_assignments")
    .select("*")
    .eq("job_id", input.job_id)
    .eq("employee_id", input.employee_id)
    .eq("work_date", input.work_date)
    .maybeSingle();
  const ex = existing as { scheduled_start_time: string | null; scheduled_end_time: string | null; scheduled_hours: number; note: string | null } | null;
  // Coalesce a blank note to the existing one too (symmetric with the times
  // below) — re-submitting the always-blank Schedule form to change only a time
  // must not wipe the crew's gate code / parking instructions (audit round 5).
  const note = ((input.note ?? "").trim().slice(0, 500) || null) ?? ex?.note ?? null;

  // Coalesce BLANK time inputs to the existing row's values on an edit — so
  // re-submitting the (always-blank) Schedule form just to change a note doesn't
  // wipe the shift's times and snap 8.5h → 8h (audit round 3). A fresh insert has
  // nothing to preserve, so blanks fall through to the 8h default.
  const finalStart = start ?? ex?.scheduled_start_time ?? null;
  const finalEnd = end ?? ex?.scheduled_end_time ?? null;
  // Validate the COALESCED pair, not just raw inputs — editing only ONE side
  // could otherwise persist a backwards start>end range with stale hours (audit
  // round 4).
  if (finalStart && finalEnd && hoursBetween(finalStart, finalEnd) == null) {
    return { ok: false, error: "End time must be after start time." };
  }
  let hours: number;
  const derived = finalStart && finalEnd ? hoursBetween(finalStart, finalEnd) : null;
  if (derived != null) hours = derived;
  else if (input.hours != null && Number.isFinite(input.hours) && input.hours > 0 && input.hours <= 24) hours = input.hours;
  else if (ex) hours = ex.scheduled_hours; // preserve the existing hours on an edit
  else hours = 8;

  const row = {
    scheduled_hours: hours,
    scheduled_start_time: finalStart,
    scheduled_end_time: finalEnd,
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

  // Auto-advance the work order's status when crew is put on the calendar for it:
  // a job still sitting at "estimating" or "ready to schedule" is, by definition,
  // now SCHEDULED. Only nudges FORWARD from a pre-schedule stage — never regresses
  // a job that's already in progress / almost done / complete / on hold (Karan
  // 2026-08: "if a WO is ready-to-schedule but I schedule it, the status should
  // change"). Best-effort — a failure here must not fail the scheduling action.
  try {
    const { data: job } = await sb
      .from("commercial_jobs")
      .select("status")
      .eq("id", input.job_id)
      .is("deleted_at", null)
      .maybeSingle();
    const cur = (job as { status: JobStatus } | null)?.status;
    if (cur === "estimating" || cur === "ready_to_schedule") {
      await sb
        .from("commercial_jobs")
        .update({ status: "scheduled", updated_at: new Date().toISOString() })
        .eq("id", input.job_id);
      await logUpdate("commercial_jobs", input.job_id, { status: cur }, { status: "scheduled" }, input.actor_user_id);
    }
  } catch (err) {
    console.warn("[field-ops] auto-advance job status on schedule failed:", err);
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
  opts?: { acknowledgeOffCrew?: boolean; excludeEmployeeIds?: string[] },
): Promise<
  | { ok: true; copied: number; skippedExisting: number; skippedAbsent: number; skippedDeletedJob: number; skippedInactive: number; skippedOffCrew: number; targetMonday: string }
  | { ok: true; needsConfirm: true; offCrew: { employee_id: string; name: string }[]; targetMonday: string }
  | { ok: false; error: string }
> {
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
  if (src.length === 0) return { ok: true, copied: 0, skippedExisting: 0, skippedAbsent: 0, skippedDeletedJob: 0, skippedInactive: 0, skippedOffCrew: 0, targetMonday: tgtMon };

  // Target-week existing assignments (to dedup), absences (to skip), live jobs +
  // active employees (don't re-schedule a terminated crew member — active=false).
  const [{ data: tgtRows }, { data: absRows }, { data: jobRows }, { data: empRows }, { data: srcAbsRows }] = await Promise.all([
    sb.from("commercial_assignments").select("job_id, employee_id, work_date").gte("work_date", tgtMon).lte("work_date", tgtSun).neq("status", "cancelled"),
    sb.from("commercial_absences").select("employee_id, work_date, hours").gte("work_date", tgtMon).lte("work_date", tgtSun),
    sb.from("commercial_jobs").select("id").is("deleted_at", null).in("id", [...new Set(src.map((s) => s.job_id))]),
    sb.from("commercial_employees").select("id, display_name").eq("active", true).in("id", [...new Set(src.map((s) => s.employee_id))]),
    // SOURCE-week absences → crew who were marked off THIS week. Karan 2026-08:
    // don't silently carry a one-week absence forward — confirm they're working
    // next week before copying their shifts.
    sb.from("commercial_absences").select("employee_id, hours").gte("work_date", srcMon).lte("work_date", srcSun),
  ]);
  const existing = new Set(((tgtRows ?? []) as { job_id: string; employee_id: string; work_date: string }[]).map((r) => `${r.job_id}|${r.employee_id}|${String(r.work_date).slice(0, 10)}`));
  // Only a FULL-day absence (hours == null) blocks copying a shift — a partial
  // (half-day) absence still lets the person's other shift copy forward (round 15).
  const absent = new Set(
    ((absRows ?? []) as { employee_id: string; work_date: string; hours: number | null }[])
      .filter((r) => r.hours == null)
      .map((r) => `${r.employee_id}|${String(r.work_date).slice(0, 10)}`)
  );
  const liveJobs = new Set(((jobRows ?? []) as { id: string }[]).map((r) => r.id));
  const liveEmpRows = (empRows ?? []) as { id: string; display_name: string | null }[];
  const liveEmps = new Set(liveEmpRows.map((r) => r.id));
  const empName = new Map(liveEmpRows.map((r) => [r.id, (r.display_name ?? "").trim() || "(crew)"]));

  // Crew marked OFF (full-day) in the SOURCE week who have shifts that would copy
  // forward. If the caller hasn't confirmed, return them for a confirm prompt so a
  // one-week absence doesn't silently propagate into next week (Karan 2026-08).
  const excludeSet = new Set(opts?.excludeEmployeeIds ?? []);
  if (!opts?.acknowledgeOffCrew) {
    const srcOffEmp = new Set(
      ((srcAbsRows ?? []) as { employee_id: string; hours: number | null }[])
        .filter((r) => r.hours == null)
        .map((r) => r.employee_id)
    );
    const srcShiftEmp = new Set(src.filter((s) => liveJobs.has(s.job_id) && liveEmps.has(s.employee_id)).map((s) => s.employee_id));
    const offCrew = [...srcOffEmp]
      .filter((id) => srcShiftEmp.has(id))
      .map((id) => ({ employee_id: id, name: empName.get(id) ?? "(crew)" }));
    if (offCrew.length > 0) return { ok: true, needsConfirm: true, offCrew, targetMonday: tgtMon };
  }

  let copied = 0, skippedExisting = 0, skippedAbsent = 0, skippedDeletedJob = 0, skippedInactive = 0, skippedOffCrew = 0;
  const toInsert: Record<string, unknown>[] = [];
  for (const s of src) {
    const tgtDate = addDaysIso(String(s.work_date).slice(0, 10), 7);
    if (!liveJobs.has(s.job_id)) { skippedDeletedJob += 1; continue; }
    if (!liveEmps.has(s.employee_id)) { skippedInactive += 1; continue; } // terminated crew — don't re-schedule
    if (excludeSet.has(s.employee_id)) { skippedOffCrew += 1; continue; } // off this week, user said skip them
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
    // Schedule clock-in nudges for any copied shift landing TODAY or TOMORROW —
    // the daily cron only nudges today+tomorrow and may have already run (e.g. a
    // Sunday-afternoon copy where tomorrow=Monday), so those early shifts would
    // otherwise get no reminder. resync is claim-dedup-safe with the cron and
    // sends no shift email (audit round 4). Later days are covered by the cron.
    const today = todayEtIso();
    const tomorrow = addDaysIso(today, 1);
    const nudgePairs = new Set<string>();
    for (const r of toInsert) {
      const wd = String((r as { work_date: string }).work_date);
      if (wd === today || wd === tomorrow) nudgePairs.add(`${(r as { employee_id: string }).employee_id}|${wd}`);
    }
    if (nudgePairs.size > 0) {
      const { resyncClockReminder } = await import("./schedule-email-send");
      for (const p of nudgePairs) {
        const [emp, day] = p.split("|");
        await resyncClockReminder(emp, day).catch(() => undefined);
      }
    }

    // Auto-advance the copied work orders' status, same as scheduling ONE crew
    // member does (upsertAssignment): a job someone was just put on the calendar
    // for is now Scheduled. Without this, Copy Week Forward would leave every
    // copied job stuck at "Ready to schedule" on the Status board even though the
    // crew is on it. Forward-only — never regresses in-progress/complete jobs.
    const copiedJobIds = [...new Set(toInsert.map((r) => String((r as { job_id: string }).job_id)))];
    if (copiedJobIds.length > 0) {
      const { data: toAdvance } = await sb
        .from("commercial_jobs")
        .select("id")
        .in("id", copiedJobIds)
        .in("status", ["estimating", "ready_to_schedule"])
        .is("deleted_at", null);
      const advIds = ((toAdvance ?? []) as { id: string }[]).map((j) => j.id);
      if (advIds.length > 0) {
        await sb.from("commercial_jobs").update({ status: "scheduled", updated_at: new Date().toISOString() }).in("id", advIds);
        for (const id of advIds) await logUpdate("commercial_jobs", id, { status: "pre_schedule" }, { status: "scheduled" }, actorUserId);
      }
    }
  }
  return { ok: true, copied, skippedExisting, skippedAbsent, skippedDeletedJob, skippedInactive, skippedOffCrew, targetMonday: tgtMon };
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
  // Re-sync the queued reminders (1-day / 1-hour / 10-min): cancel them, and if
  // the crew member still has ANOTHER shift that day, re-schedule for the earliest
  // remaining start. A bare cancel would drop reminders for a still-scheduled
  // shift, and the once-daily cron can't fix a same-day removal (audit 2026-08).
  const ex = existing as { employee_id?: string; work_date?: string; job_id?: string };
  if (ex.employee_id && ex.work_date) {
    const { resyncClockReminder } = await import("./schedule-email-send");
    await resyncClockReminder(ex.employee_id, ex.work_date).catch(() => undefined);
  }

  // Reverse the auto-status when that was the work order's LAST crew: scheduled →
  // ready_to_schedule. Mirrors the forward advance on scheduling, so a work order
  // doesn't keep showing "Scheduled" on the Status board with nothing on the
  // calendar (Karan 2026-08 — the stuck "k · Scheduled" case). Only walks back the
  // auto 'scheduled' state; never touches a manually-advanced in_progress /
  // almost_done / complete / on_hold job.
  if (ex.job_id) {
    const { count } = await sb
      .from("commercial_assignments")
      .select("id", { count: "exact", head: true })
      .eq("job_id", ex.job_id)
      .neq("status", "cancelled");
    if ((count ?? 0) === 0) {
      const { data: job } = await sb
        .from("commercial_jobs")
        .select("status")
        .eq("id", ex.job_id)
        .is("deleted_at", null)
        .maybeSingle();
      if ((job as { status: string } | null)?.status === "scheduled") {
        await sb
          .from("commercial_jobs")
          .update({ status: "ready_to_schedule", updated_at: new Date().toISOString() })
          .eq("id", ex.job_id);
        await logUpdate("commercial_jobs", ex.job_id, { status: "scheduled" }, { status: "ready_to_schedule" }, actorUserId);
      }
    }
  }
  return { ok: true };
}


// ── Crew self-service (scoped to ONE employee) ─────────────────────────────

export type MyShift = {
  assignment_id: string;
  work_date: string;
  job_id: string;
  job_name: string;
  job_code: string;
  site: string | null;
  scheduled_hours: number;
  start_time: string | null;
  end_time: string | null;
  note: string | null;
};

/**
 * One crew member's upcoming shifts.
 *
 * Written as its own query rather than filtering getMonthOverview/getDaySchedule
 * ON PURPOSE. Those are company-wide — every employee, every job — and building
 * a personal view by fetching everyone and filtering in memory means the leak is
 * one dropped `.filter()` away, with nothing to catch it. Here the employee id
 * is in the WHERE clause, so the query cannot return another person's row.
 *
 * Selects only what a crew member needs to show up in the right place at the
 * right time: no pay rates, no other crew on the job, no deal money.
 */
export async function listMyUpcomingShifts(
  employeeId: string,
  fromIso: string,
  toIso: string
): Promise<MyShift[]> {
  if (!employeeId) return [];
  const sb = commercialDb();
  const rows = await paginateAll<{
    id: string;
    work_date: string;
    job_id: string;
    scheduled_hours: number | null;
    scheduled_start_time: string | null;
    scheduled_end_time: string | null;
    note: string | null;
  }>(() =>
    sb
      .from("commercial_assignments")
      .select("id, work_date, job_id, scheduled_hours, scheduled_start_time, scheduled_end_time, note")
      .eq("employee_id", employeeId)
      .neq("status", "cancelled")
      .gte("work_date", fromIso)
      .lte("work_date", toIso)
      .order("work_date", { ascending: true })
      .order("id", { ascending: true })
  );
  if (rows.length === 0) return [];

  const jobIds = Array.from(new Set(rows.map((r) => r.job_id).filter(Boolean)));
  const jobById = new Map<string, { name: string; code: string; site: string | null }>();
  if (jobIds.length > 0) {
    // Narrow column list on purpose — commercial_jobs also carries internal
    // notes, customer_name and estimated_labor_hours, none of which a crew
    // member should receive. Address is site_address/site_city (there is no
    // `site` column; selecting one 42703s and, because the error was ignored,
    // silently rendered every shift as "Job" with no location).
    const { data: jobs, error } = await sb
      .from("commercial_jobs")
      .select("id, name, job_code, site_address, site_city")
      .in("id", jobIds)
      .is("deleted_at", null);
    if (error) console.warn("[listMyUpcomingShifts] job lookup failed:", error.message);
    for (const j of (jobs ?? []) as { id: string; name: string | null; job_code: string | null; site_address: string | null; site_city: string | null }[]) {
      const site = [j.site_address, j.site_city].filter(Boolean).join(", ") || null;
      jobById.set(j.id, { name: j.name ?? "Job", code: j.job_code ?? "", site });
    }
  }
  return rows.map((r) => {
    const j = jobById.get(r.job_id);
    return {
      assignment_id: r.id,
      work_date: r.work_date,
      job_id: r.job_id,
      job_name: j?.name ?? "Job",
      job_code: j?.code ?? "",
      site: j?.site ?? null,
      scheduled_hours: Number(r.scheduled_hours ?? 0),
      start_time: r.scheduled_start_time,
      end_time: r.scheduled_end_time,
      note: r.note,
    };
  });
}

/** Days this crew member is marked off in the window — their own only. */
export async function listMyAbsences(
  employeeId: string,
  fromIso: string,
  toIso: string
): Promise<{ work_date: string; reason: string | null }[]> {
  if (!employeeId) return [];
  const sb = commercialDb();
  const { absenceLabel } = await import("./absence-constants");
  // The column is `type` (enum), not `reason` — selecting `reason` 42703s and,
  // with the error ignored, time-off silently never rendered at all.
  const { data, error } = await sb
    .from("commercial_absences")
    .select("work_date, type")
    .eq("employee_id", employeeId)
    .gte("work_date", fromIso)
    .lte("work_date", toIso)
    .order("work_date", { ascending: true });
  if (error) console.warn("[listMyAbsences] failed:", error.message);
  return ((data ?? []) as { work_date: string; type: string }[]).map((a) => ({
    work_date: a.work_date,
    reason: absenceLabel(a.type as Parameters<typeof absenceLabel>[0]),
  }));
}
