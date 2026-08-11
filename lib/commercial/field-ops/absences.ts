import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";
import { ABSENCE_TYPES, absenceLabel, absenceShort, isAbsenceType, type AbsenceType } from "./absence-constants";

export { ABSENCE_TYPES, absenceLabel, absenceShort, isAbsenceType };
export type { AbsenceType };

/**
 * Crew absences (commercial_absences) — PTO / Sick / Holiday etc., the P/S/NW/NA
 * codes from Tomco's real timesheet. Structured enum types (never free text), so
 * "who's off" is queryable and the scheduler can see it right on the calendar and
 * be warned before double-booking someone who's out.
 *
 * One absence per employee per day (a person is either off or not). Absences are
 * ATTENDANCE tracking only in v1 — they do NOT feed payroll (PTO pay is a later
 * phase); they surface on the schedule so nobody schedules an out crew member.
 */

export type DayAbsence = {
  id: string;
  employee_id: string;
  employee_name: string;
  work_date: string;
  type: AbsenceType;
  hours: number | null;
  note: string | null;
};

/** All absences in [startIso, endIso] (inclusive), keyed by work_date, each with
 *  the employee's display name. One pass for the whole calendar month. */
export async function getAbsencesForRange(startIso: string, endIso: string): Promise<Map<string, DayAbsence[]>> {
  const out = new Map<string, DayAbsence[]>();
  const sb = commercialDb();
  const { data: aRows } = await sb
    .from("commercial_absences")
    .select("id, employee_id, work_date, type, hours, note")
    .gte("work_date", startIso)
    .lte("work_date", endIso);
  const rows = (aRows ?? []) as { id: string; employee_id: string; work_date: string; type: AbsenceType; hours: number | null; note: string | null }[];
  if (rows.length === 0) return out;

  const empIds = [...new Set(rows.map((r) => r.employee_id))];
  const { data: empRows } = await sb.from("commercial_employees").select("id, display_name").in("id", empIds);
  const empName = new Map((empRows ?? []).map((r) => [(r as { id: string }).id, (r as { display_name: string }).display_name]));

  for (const r of rows) {
    const date = String(r.work_date).slice(0, 10);
    const arr = out.get(date) ?? [];
    arr.push({
      id: r.id,
      employee_id: r.employee_id,
      employee_name: empName.get(r.employee_id) ?? "(crew)",
      work_date: date,
      type: r.type,
      hours: r.hours,
      note: r.note,
    });
    out.set(date, arr);
  }
  for (const arr of out.values()) arr.sort((a, b) => a.employee_name.localeCompare(b.employee_name));
  return out;
}

/** Absences on a single day (day panel). */
export async function getDayAbsences(dateIso: string): Promise<DayAbsence[]> {
  const m = await getAbsencesForRange(dateIso, dateIso);
  return m.get(dateIso) ?? [];
}

/** Employee-ids marked off on a given day — for the "already off" schedule warning. */
export async function absentEmployeeIdsOn(dateIso: string): Promise<Set<string>> {
  const list = await getDayAbsences(dateIso);
  return new Set(list.map((a) => a.employee_id));
}

/**
 * Mark (or update) one crew member off for one day. One absence per person per
 * day — a re-mark updates the type/hours/note in place. Returns {ok}.
 */
// Marking someone off (or un-marking them) changes whether their clock-in nudge
// should fire — re-sync it. getShiftsForRange is absence-aware, so on mark-off
// this cancels the queued nudge; on delete it restores it if a shift remains.
async function resyncNudge(employeeId: string, workDate: string): Promise<void> {
  const { resyncClockReminder } = await import("./schedule-email-send");
  await resyncClockReminder(employeeId, workDate).catch(() => undefined);
}

// Email the crew member the reason IF they were already scheduled that day
// (Karan 2026-08: "mark someone off who was scheduled → email them the reason").
// Only on mark-off (upsert), never on un-mark (delete). Best-effort.
async function notifyMarkedOff(employeeId: string, workDate: string, type: string, hours: number | null): Promise<void> {
  try {
    const { sendAbsenceNotice } = await import("./schedule-email-send");
    await sendAbsenceNotice(employeeId, workDate, type, hours);
  } catch (err) {
    console.warn("[field-ops] notifyMarkedOff failed:", err);
  }
}

export async function upsertAbsence(input: {
  employee_id: string;
  work_date: string;
  type: string;
  hours?: number | null;
  note?: string | null;
  actor_user_id: string;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!isAbsenceType(input.type)) return { ok: false, error: "Pick a valid absence type." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.work_date)) return { ok: false, error: "Invalid date." };
  let hours: number | null = input.hours == null ? null : Number(input.hours);
  if (hours != null && (!Number.isFinite(hours) || hours <= 0 || hours > 24)) hours = null;
  const note = (input.note ?? "").trim().slice(0, 500) || null;
  const sb = commercialDb();

  const { data: existing } = await sb
    .from("commercial_absences")
    .select("*")
    .eq("employee_id", input.employee_id)
    .eq("work_date", input.work_date)
    .maybeSingle();

  if (existing) {
    const { data, error } = await sb
      .from("commercial_absences")
      .update({ type: input.type, hours, note })
      .eq("id", (existing as { id: string }).id)
      .select("*")
      .single();
    if (error) return { ok: false, error: error.message };
    await logUpdate("commercial_absences", (data as { id: string }).id, existing, data, input.actor_user_id);
    await resyncNudge(input.employee_id, input.work_date);
    await notifyMarkedOff(input.employee_id, input.work_date, input.type, hours);
    return { ok: true, id: (data as { id: string }).id };
  }

  const { data, error } = await sb
    .from("commercial_absences")
    .insert({ employee_id: input.employee_id, work_date: input.work_date, type: input.type, hours, note })
    .select("*")
    .single();
  if (error) {
    // Raced with a concurrent insert (unique index, migration 119) — collapse to
    // the existing row + update it instead of compounding a duplicate (audit round 7).
    if (/duplicate key|unique/i.test(error.message)) {
      const { data: existRow } = await sb
        .from("commercial_absences")
        .select("*")
        .eq("employee_id", input.employee_id)
        .eq("work_date", input.work_date)
        .maybeSingle();
      if (existRow) {
        const { data: upd, error: uErr } = await sb
          .from("commercial_absences")
          .update({ type: input.type, hours, note })
          .eq("id", (existRow as { id: string }).id)
          .select("*")
          .single();
        if (uErr) return { ok: false, error: uErr.message };
        await logUpdate("commercial_absences", (upd as { id: string }).id, existRow, upd, input.actor_user_id);
        await resyncNudge(input.employee_id, input.work_date);
        await notifyMarkedOff(input.employee_id, input.work_date, input.type, hours);
        return { ok: true, id: (upd as { id: string }).id };
      }
    }
    return { ok: false, error: error.message };
  }
  await logInsert("commercial_absences", (data as { id: string }).id, data, input.actor_user_id);
  await resyncNudge(input.employee_id, input.work_date);
  await notifyMarkedOff(input.employee_id, input.work_date, input.type, hours);
  return { ok: true, id: (data as { id: string }).id };
}

export async function deleteAbsence(id: string, actorUserId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: existing } = await sb.from("commercial_absences").select("*").eq("id", id).maybeSingle();
  if (!existing) return { ok: true };
  const { error } = await sb.from("commercial_absences").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  await logDelete("commercial_absences", id, existing, actorUserId);
  const ex = existing as { employee_id?: string; work_date?: string };
  if (ex.employee_id && ex.work_date) await resyncNudge(ex.employee_id, ex.work_date);
  return { ok: true };
}
