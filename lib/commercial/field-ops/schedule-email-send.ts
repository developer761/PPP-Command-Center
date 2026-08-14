import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { addDaysIso, todayEtIso, etWallTimeToUtcIso, fmtTime12 } from "./schedule";
import { getCrewScopeForOpp, type CrewScope } from "@/lib/commercial/work-orders/db";
import { listScheduleRecipients } from "./schedule-emails";
import { absenceLabel } from "./absence-constants";
import type { CommercialEmployee } from "./employees";

/**
 * R10.7 - painter schedule emails. Cadence:
 *   1. WELCOME — instant on add (their magic link, so they can clock in day one).
 *   2. SHIFT — instant whenever they're placed on the Calendar (the day's shifts
 *      + times + the note the scheduler wrote), and schedules their reminders.
 *   3. DAY-OF — each morning, today's shift (a change is never missed).
 *   4. PRE-SHIFT REMINDERS — 1 DAY, 1 HOUR, and 10 MIN before their first start
 *      time, each an independent Resend scheduled send carrying that crew member's
 *      personal clock-in/out magic link (no minute-by-minute cron needed). All
 *      three are cancelled + rescheduled together if the start time changes, and
 *      suppressed once the painter has clocked in.
 *   5. WEEKLY — every Sunday, the full week ahead.
 * Office recipients get a daily "who's on today" digest + the Sunday week-ahead.
 * All crew mail is bilingual (en/es) and respects schedule_email_opt_out.
 * A per-(employee, date, kind) log makes the daily run idempotent.
 */

// Crew reminder cadence before a shift's start. Each is an INDEPENDENT Resend
// scheduled send carrying that crew member's personal clock-in/out magic link, so
// no minute-by-minute cron is needed. Karan 2026-08: "1 day, 1 hour, and 10
// minutes before." Deduped per (employee, work_date, kind); all three are
// cancelled + rescheduled together when a shift's start time changes.
type ReminderKind = "reminder_1day" | "reminder_1hour" | "clock_reminder";
type EmailKind = "day_of" | "weekly" | ReminderKind;
const REMINDERS: { kind: ReminderKind; leadMin: number }[] = [
  { kind: "reminder_1day", leadMin: 24 * 60 },
  { kind: "reminder_1hour", leadMin: 60 },
  { kind: "clock_reminder", leadMin: 10 },
];

// The earliest shift start on a day whose (start − leadMin) fire time is still in
// the FUTURE. Taking the earliest start OVERALL would drop the reminder when an
// earlier shift's fire time has already passed but a later shift is still upcoming
// (audit round 6) — so a mid-day resave would leave the still-upcoming shift with
// no reminder. Per-lead so each of the three reminders targets the right shift.
function earliestNudgeableStart(workDate: string, starts: (string | null)[], leadMin: number): string | null {
  for (const s of (starts.filter(Boolean) as string[]).sort()) {
    const startUtc = etWallTimeToUtcIso(workDate, s);
    if (!startUtc) continue;
    if (Date.parse(startUtc) - leadMin * 60_000 > Date.now()) return s;
  }
  return null;
}

/** Bilingual copy for each reminder kind. All three carry the same personal
 *  clock-in/out magic link. */
function reminderCopy(
  kind: ReminderKind,
  firstName: string,
  workDate: string,
  startTime: string,
  link: string,
  ocName: string,
  es: boolean
): { subject: string; text: string } {
  const t = fmtTime12(startTime);
  const day = dayLabel(workDate, es);
  if (kind === "reminder_1day") {
    return es
      ? { subject: `Recordatorio - trabajas manana (${day})`, text: `Hola ${firstName},\n\nRecordatorio: estas programado manana, ${day}, empezando a las ${t}. Marca entrada/salida aqui cuando llegues:\n\n${link}\n\n- ${ocName}` }
      : { subject: `Reminder - you work tomorrow (${day})`, text: `Hi ${firstName},\n\nReminder: you're scheduled tomorrow, ${day}, starting at ${t}. Clock in/out here when you arrive:\n\n${link}\n\n- ${ocName}` };
  }
  if (kind === "reminder_1hour") {
    return es
      ? { subject: `Tu turno empieza pronto - ${t}`, text: `Hola ${firstName},\n\nTu turno empieza en aproximadamente una hora, a las ${t}. Toca aqui para marcar entrada (y salida cuando termines):\n\n${link}\n\n- ${ocName}` }
      : { subject: `Your shift starts soon - ${t}`, text: `Hi ${firstName},\n\nYour shift starts in about an hour, at ${t}. Tap here to clock in (and clock out when you finish):\n\n${link}\n\n- ${ocName}` };
  }
  // clock_reminder — 10 minutes before.
  return es
    ? { subject: `Marca entrada - empieza a las ${t}`, text: `Hola ${firstName},\n\nTu turno empieza a las ${t}. Toca aqui para marcar entrada (y salida cuando termines):\n\n${link}\n\n- ${ocName}` }
    : { subject: `Clock in - shift starts at ${t}`, text: `Hi ${firstName},\n\nYour shift starts at ${t}. Tap here to clock in (and clock out when you finish):\n\n${link}\n\n- ${ocName}` };
}

/** Did this crew member already punch in on `workDate` (ET day)? Then no reminder
 *  is needed — don't nudge someone who's already clocked in. */
async function hasPunchedThatDay(employeeId: string, workDate: string): Promise<boolean> {
  const sb = commercialDb();
  const { data: pRows } = await sb
    .from("commercial_time_punches")
    .select("clock_in_at")
    .eq("employee_id", employeeId)
    .gte("clock_in_at", `${addDaysIso(workDate, -1)}T00:00:00Z`)
    .lte("clock_in_at", `${addDaysIso(workDate, 1)}T23:59:59Z`);
  const etDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return ((pRows ?? []) as { clock_in_at: string }[]).some((p) => etDay(p.clock_in_at) === workDate);
}

function baseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") || "https://hub.precisionpaintingplus.net";
}
function magicLink(token: string | null | undefined): string {
  return token ? `${baseUrl()}/f/${token}` : baseUrl();
}
function fromLine(ocName: string): string | undefined {
  const addr = process.env.COMMERCIAL_RESEND_FROM_ADDRESS || process.env.RESEND_FROM_ADDRESS;
  return addr ? `${ocName} <${addr}>` : undefined;
}

function dayLabel(iso: string, es: boolean): string {
  return new Date(iso + "T12:00:00Z").toLocaleDateString(es ? "es-US" : "en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

/** Day-of-week for a plain ET date (0=Sun..6=Sat). Parsed at noon UTC so it never shifts. */
function dowOf(iso: string): number {
  return new Date(iso + "T12:00:00Z").getUTCDay();
}

type Shift = {
  name: string; site: string | null; hours: number; pw: boolean;
  start: string | null; end: string | null; note: string | null;
  /** Deal + work order, so the crew email can say WHAT the job is — the scope
   *  reached the PDF and nowhere else, so someone scheduled onto a job was told
   *  where and when but never what (Karan 2026-08). */
  opportunityId: string | null;
  workOrderId: string | null;
};
type UpDay = { date: string; jobs: Shift[] };

async function getShiftsForRange(employeeId: string, fromIso: string, numDays: number): Promise<UpDay[]> {
  const sb = commercialDb();
  const toIso = addDaysIso(fromIso, numDays - 1);
  const { data: aRows } = await sb
    .from("commercial_assignments")
    .select("job_id, work_date, scheduled_hours, scheduled_start_time, scheduled_end_time, note")
    .eq("employee_id", employeeId)
    .gte("work_date", fromIso)
    .lte("work_date", toIso)
    .neq("status", "cancelled");
  const assigns = (aRows ?? []) as {
    job_id: string; work_date: string; scheduled_hours: number;
    scheduled_start_time: string | null; scheduled_end_time: string | null; note: string | null;
  }[];
  if (assigns.length === 0) return [];
  // Days this employee is marked OFF (PTO/Sick/…) — suppress the schedule email
  // AND the clock-in nudge for those days, so someone marked off is never pinged
  // to clock in or told "today's work" (audit 2026-08). Mirrors copy-week's skip.
  const { data: absRows } = await sb
    .from("commercial_absences")
    .select("work_date, hours")
    .eq("employee_id", employeeId)
    .gte("work_date", fromIso)
    .lte("work_date", toIso);
  // Only a FULL-day absence (hours == null) suppresses the day's shift email +
  // clock-in nudge. A PARTIAL absence (hours set — e.g. a half day) still lets an
  // afternoon shift on the SAME day notify + nudge (audit round 15).
  const offDates = new Set(
    ((absRows ?? []) as { work_date: string; hours: number | null }[]).filter((r) => r.hours == null).map((r) => String(r.work_date).slice(0, 10))
  );
  const jobIds = [...new Set(assigns.map((a) => a.job_id))];
  const jobsById = new Map<string, { name: string; site_address: string | null; site_city: string | null; prevailing_wage: boolean; opportunity_id: string | null; work_order_id: string | null }>();
  const { data: jobs } = await sb.from("commercial_jobs").select("id, name, site_address, site_city, prevailing_wage, opportunity_id, work_order_id").in("id", jobIds).is("deleted_at", null);
  for (const j of (jobs ?? []) as { id: string; name: string; site_address: string | null; site_city: string | null; prevailing_wage: boolean; opportunity_id: string | null; work_order_id: string | null }[])
    jobsById.set(j.id, j);

  const byDate = new Map<string, UpDay>();
  for (let i = 0; i < numDays; i++) {
    const d = addDaysIso(fromIso, i);
    if (offDates.has(d)) continue; // employee is marked off this day — no email / nudge
    const dayAssigns = assigns
      .filter((a) => a.work_date === d && jobsById.has(a.job_id)) // drop shifts for deleted work orders
      .sort((x, y) => (x.scheduled_start_time ?? "99").localeCompare(y.scheduled_start_time ?? "99"));
    if (dayAssigns.length === 0) continue;
    byDate.set(d, {
      date: d,
      jobs: dayAssigns.map((a) => {
        const j = jobsById.get(a.job_id);
        return {
          name: j?.name ?? "(work order)",
          site: [j?.site_address, j?.site_city].filter(Boolean).join(", ") || null,
          hours: a.scheduled_hours,
          pw: j?.prevailing_wage ?? false,
          start: a.scheduled_start_time,
          end: a.scheduled_end_time,
          note: a.note,
          opportunityId: j?.opportunity_id ?? null,
          workOrderId: j?.work_order_id ?? null,
        };
      }),
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// `scope` is REQUIRED, not optional. It started out optional and three of the
// four email paths simply never passed it — the calls compiled, and most crew
// on most days got a schedule with no work on it. Pass `null` deliberately if
// there genuinely is no scope.
function shiftLine(j: Shift, es: boolean, scope: CrewScope | null | undefined): string {
  const pw = es ? "salario prevaleciente" : "prevailing wage";
  const times = j.start ? `${fmtTime12(j.start)}${j.end ? `-${fmtTime12(j.end)}` : ""}` : `${j.hours}h`;
  let line = `  - ${j.name}${j.site ? ` (${j.site})` : ""} - ${times}${j.pw ? ` [${pw}]` : ""}`;
  if (j.note) line += `\n      ${es ? "Nota" : "Note"}: ${j.note}`;
  // WHAT you're working on. Partial sheets say so explicitly — being handed 3
  // of 6 items with no denominator is how a crew stops early thinking they're
  // done, or two crews both skip the line neither was told about.
  if (scope && scope.lines.length > 0) {
    const heading = scope.isPartial
      ? es
        ? `Tu alcance (${scope.lines.length} de ${scope.totalLines}):`
        : `Your scope (${scope.lines.length} of ${scope.totalLines}):`
      : es
        ? "Alcance:"
        : "Scope:";
    line += `\n      ${scope.areaLabel ? `${scope.areaLabel} — ` : ""}${heading}`;
    for (const l of scope.lines) line += `\n        * ${l}`;
    if (scope.isPartial) {
      line += `\n      ${es ? "Solo estos puntos - el resto esta en otra orden." : "These items only - the rest is on another work order."}`;
    }
  }
  return line;
}

/** Key a job by the sheet its scope comes from, so we resolve each one once. */
const scopeKey = (j: Shift) => `${j.opportunityId}|${j.workOrderId ?? ""}`;

/**
 * Resolve the crew scope for every job across a set of days.
 *
 * Scope reached only the shift-assignment email at first, so the morning
 * "what am I painting today" email and the weekly schedule both went out with
 * a time and an address and nothing about the work. Resolving it in one place
 * means a new email path gets it by construction.
 */
async function scopesFor(days: UpDay[]): Promise<Map<string, CrewScope | null>> {
  const out = new Map<string, CrewScope | null>();
  for (const d of days) {
    for (const j of d.jobs) {
      if (!j.opportunityId) continue;
      const key = scopeKey(j);
      if (out.has(key)) continue;
      out.set(key, await getCrewScopeForOpp(j.opportunityId, j.workOrderId).catch(() => null));
    }
  }
  return out;
}

function buildBody(
  firstName: string,
  upcoming: UpDay[],
  link: string,
  ocName: string,
  es: boolean,
  scopes?: Map<string, CrewScope | null>
): string {
  const L = es
    ? { hi: `Hola ${firstName},`, intro: "Aqui esta tu horario:", none: "No tienes trabajos programados todavia.", cta: "Abre esto en tu telefono para ver tu horario y marcar entrada/salida:" }
    : { hi: `Hi ${firstName},`, intro: "Here's your schedule:", none: "No jobs scheduled for you yet.", cta: "Open this on your phone to see your schedule and clock in/out:" };
  const lines: string[] = [L.hi, "", L.intro, ""];
  if (upcoming.length === 0) lines.push(L.none, "");
  else
    for (const d of upcoming) {
      lines.push(dayLabel(d.date, es));
      for (const j of d.jobs)
        lines.push(shiftLine(j, es, j.opportunityId ? scopes?.get(scopeKey(j)) : null));
      lines.push("");
    }
  lines.push(L.cta, link, "", `- ${ocName}`);
  return lines.join("\n");
}

/* ── dedup log — claim-before-send so a cron retry never double-fires ──────── */

/** Atomically claim (employee, date, kind). Returns true if WE claimed it (so we
 *  should send), false if it was already claimed. The UNIQUE constraint is the
 *  real guard — safe even if two cron runs overlap. */
async function claimSend(employeeId: string, workDate: string, kind: EmailKind): Promise<string | null> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_schedule_email_log")
    .insert({ employee_id: employeeId, work_date: workDate, kind })
    .select("id")
    .single();
  if (error) return null; // error (incl. unique violation) => already claimed
  return (data as { id: string }).id;
}

/** Roll back a claim so a later run/edit can re-fire — used when the send fails
 *  (transient Resend error) so a claim-before-send never permanently suppresses
 *  a notification. */
async function releaseClaim(employeeId: string, workDate: string, kind: EmailKind): Promise<void> {
  const sb = commercialDb();
  await sb
    .from("commercial_schedule_email_log")
    .delete()
    .eq("employee_id", employeeId)
    .eq("work_date", workDate)
    .eq("kind", kind);
}

/** Cancel ONE reminder kind's scheduled send + drop its claim so a start-time
 *  change reschedules a fresh, correctly-timed one (and the stale one doesn't
 *  fire). Same fired/pending-with-id/pending-without-id handling proven on the
 *  10-min nudge, now applied per kind. */
async function resetReminderKind(employeeId: string, workDate: string, kind: ReminderKind): Promise<void> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_schedule_email_log")
    .select("id, resend_message_id, sent_at")
    .eq("employee_id", employeeId)
    .eq("work_date", workDate)
    .eq("kind", kind)
    .maybeSingle();
  const row = data as { id: string; resend_message_id: string | null; sent_at: string | null } | null;
  if (!row) return;
  // If the reminder's stored FIRE time is already in the past, it has delivered
  // and cannot fire again — clear the row unconditionally and free the day to
  // schedule a fresh one for a pushed-later / second shift, even though Resend
  // can't "cancel" a sent email (audit round 11).
  const alreadyFired = !!row.sent_at && Date.parse(row.sent_at) < Date.now();
  let safeToClear = alreadyFired;
  if (!alreadyFired) {
    if (row.resend_message_id) {
      // Still pending WITH a cancellable id — only clear (which lets a reschedule
      // queue a NEW one) once the cancel is confirmed, else keep the row so the
      // painter doesn't get TWO reminders (audit round 10).
      const { cancelScheduledEmail } = await import("@/lib/email/resend");
      safeToClear = await cancelScheduledEmail(row.resend_message_id, "commercial");
    } else {
      // Pending but NO cancellable Resend id — keeping the row only guarantees a
      // wrong-time (or missing) reminder, because the id-less send can't be
      // cancelled regardless. Clear it so a reschedule queues a fresh correctly-
      // timed one; a rare harmless double beats a stale wrong-time one (round 14).
      safeToClear = true;
    }
  }
  if (!safeToClear) return;
  await sb.from("commercial_schedule_email_log").delete().eq("id", row.id);
}

/** Cancel ALL of a (employee, date)'s pending reminders (1-day, 1-hour, 10-min).
 *  Called on a schedule change, on clock-in, and on employee deactivation so no
 *  stale reminder fires. Keeps the original name/signature its callers rely on. */
export async function resetClockReminder(employeeId: string, workDate: string): Promise<void> {
  for (const r of REMINDERS) await resetReminderKind(employeeId, workDate, r.kind);
}

/** Schedule whichever of the three reminders are still in the future for a
 *  (employee, date), each targeting the earliest shift start ahead of its own
 *  lead. Shared by the add-shift path, the same-day resync, and the daily cron. */
async function scheduleAllReminders(
  employeeId: string,
  workDate: string,
  starts: (string | null)[],
  emp: { first_name: string; email: string | null; preferred_language: "en" | "es" },
  ocName: string,
  link: string
): Promise<number> {
  let n = 0;
  for (const r of REMINDERS) {
    const s = earliestNudgeableStart(workDate, starts, r.leadMin);
    if (!s) continue;
    await scheduleReminder(employeeId, workDate, s, emp, ocName, link, r.kind, r.leadMin);
    n++;
  }
  return n;
}

/**
 * Re-sync a (employee, date)'s reminders after a SAME-DAY schedule change (a
 * shift removed, or the person marked off): cancel all queued reminders, then
 * re-schedule them for the day's EARLIEST REMAINING shift — or leave them
 * cancelled if nothing remains (or the day is now an absence, which
 * getShiftsForRange already suppresses). The once-daily cron can't cover same-day
 * edits, so a bare cancel would drop reminders for a shift that's still on the
 * books (audit 2026-08).
 */
export async function resyncClockReminder(employeeId: string, workDate: string): Promise<void> {
  try {
    await resetClockReminder(employeeId, workDate);
    const shifts = await getShiftsForRange(employeeId, workDate, 1);
    if (shifts.length === 0) return; // nothing left that day → stay cancelled
    const sb = commercialDb();
    const { data: e } = await sb
      .from("commercial_employees")
      .select("first_name, email, preferred_language, schedule_email_opt_out, magic_link_token")
      .eq("id", employeeId)
      .eq("active", true)
      .maybeSingle();
    const emp = e as { first_name: string; email: string | null; preferred_language: "en" | "es"; schedule_email_opt_out: boolean; magic_link_token: string | null } | null;
    if (!emp || !emp.email || emp.schedule_email_opt_out) return; // respect opt-out (audit round 2)
    const oc = await getOperatingCompany();
    await scheduleAllReminders(employeeId, workDate, shifts[0].jobs.map((j) => j.start), emp, oc.name, magicLink(emp.magic_link_token));
  } catch (err) {
    console.warn("[field-ops] resyncClockReminder failed:", err);
  }
}

/** Has (employee, date, kind) already been claimed/sent? Read-only check. */
async function claimExists(employeeId: string, workDate: string, kind: EmailKind): Promise<boolean> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_schedule_email_log")
    .select("id")
    .eq("employee_id", employeeId)
    .eq("work_date", workDate)
    .eq("kind", kind)
    .maybeSingle();
  return !!data;
}

/* ── 1. Welcome (instant on add) ──────────────────────────────────────────── */

export async function sendWelcomeEmail(employee: CommercialEmployee): Promise<void> {
  if (!employee.email) return;
  try {
    const sb = commercialDb();
    // Read the CURRENT name, not the object the caller passed. The welcome
    // greeted "Hi k" while the shift email an hour later greeted "Hi Karan" —
    // the caller's object was captured before the name was corrected, and only
    // the shift path re-read the row.
    const { data: emp } = await sb
      .from("commercial_employees")
      .select("magic_link_token, first_name")
      .eq("id", employee.id)
      .maybeSingle();
    const row = emp as { magic_link_token?: string; first_name?: string } | null;
    const token = row?.magic_link_token ?? null;
    const firstName = row?.first_name?.trim() || employee.first_name;
    const oc = await getOperatingCompany();
    const es = employee.preferred_language === "es";
    const link = magicLink(token);
    const upcoming = await getShiftsForRange(employee.id, todayEtIso(), 7);
    const intro = es
      ? `Hola ${firstName},\n\nEstas registrado con ${oc.name}. Usa este enlace en tu telefono para ver tu horario y marcar entrada/salida cada dia - no necesitas contrasena. Guardalo en favoritos.`
      : `Hi ${firstName},\n\nYou're set up with ${oc.name}. Use this link on your phone to see your schedule and clock in/out each day - no password needed. Bookmark it.`;
    const welcomeScopes = await scopesFor(upcoming);
    const body = `${intro}\n\n${link}\n\n${upcoming.length > 0 ? buildBody(firstName, upcoming, link, oc.name, es, welcomeScopes) : `- ${oc.name}`}`;
    const { sendEmail } = await import("@/lib/email/resend");
    // sendEmail RESOLVES with {ok:false} on failure — it does not throw — so the

    // catch below never ran and releaseClaim was never called. A transient

    // Resend outage therefore marked the crew's schedule email as sent and

    // suppressed it permanently: nobody was told where to be, and nothing

    // anywhere said so.

    const sent = await sendEmail({
      channel: "commercial",
      to: employee.email,
      subject: es ? "Tu horario - Tomco Painting" : "Your schedule - Tomco Painting",
      text: body,
      ...(fromLine(oc.name) ? { from: fromLine(oc.name) } : {}),
      tags: [{ name: "kind", value: "crew_welcome" }],
    });
  } catch (err) {
    console.warn("[field-ops] welcome email failed:", err);
  }
}

/* ── 2. Shift email (instant when placed on the Calendar) ──────────────────── */

/** Email a crew member their shifts for one date (consolidated — a person on two
 *  work orders that day gets one email) and schedule their clock-in nudge. Called
 *  by upsertAssignment. No-op if they have no email or have opted out. */
export async function sendShiftAssignmentEmail(employeeId: string, workDate: string): Promise<void> {
  try {
    const sb = commercialDb();
    const { data: e } = await sb
      .from("commercial_employees")
      .select("first_name, email, preferred_language, schedule_email_opt_out, magic_link_token")
      .eq("id", employeeId)
      .eq("active", true)
      .maybeSingle();
    const emp = e as { first_name: string; email: string | null; preferred_language: "en" | "es"; schedule_email_opt_out: boolean; magic_link_token: string | null } | null;
    if (!emp || !emp.email || emp.schedule_email_opt_out) return;

    const shifts = await getShiftsForRange(employeeId, workDate, 1);
    if (shifts.length === 0) return; // all shifts for the day were removed

    // A 10-minute "don't email twice right after the welcome" suppression used
    // to sit here. It was built on a false premise: the welcome is sent when
    // the employee record is created, and it fetches their schedule AT THAT
    // MOMENT — before any assignment exists — so it goes out saying "No jobs
    // scheduled for you yet."
    //
    // The natural flow is to add a hire and put them on this week's job right
    // away, which tripped the window and swallowed the shift email: the only
    // one carrying the date, the scope of what they're painting, and the
    // clock-in nudges. The welcome is never redundant with it, so collapsing
    // them was pure information loss.
    const oc = await getOperatingCompany();
    const es = emp.preferred_language === "es";
    const link = magicLink(emp.magic_link_token);
    const head = es
      ? `Hola ${emp.first_name},\n\nEstas programado para el ${dayLabel(workDate, true)}:`
      : `Hi ${emp.first_name},\n\nYou're scheduled for ${dayLabel(workDate, false)}:`;
    const lines: string[] = [head, ""];
    // Resolve each job's crew scope so the email says WHAT, not just where/when.
    const scopeByJob = await scopesFor(shifts);
    for (const j of shifts[0].jobs) {
      lines.push(shiftLine(j, es, j.opportunityId ? scopeByJob.get(scopeKey(j)) : null));
    }
    lines.push("", es ? "Marca entrada/salida aqui:" : "Clock in/out here:", link, "", `- ${oc.name}`);
    const { sendEmail } = await import("@/lib/email/resend");
    await sendEmail({
      channel: "commercial",
      to: emp.email,
      subject: es ? `Nuevo turno - ${dayLabel(workDate, true)}` : `You're scheduled - ${dayLabel(workDate, false)}`,
      text: lines.join("\n"),
      ...(fromLine(oc.name) ? { from: fromLine(oc.name) } : {}),
      tags: [{ name: "kind", value: "crew_shift" }],
    });

    // Schedule the 1-day / 1-hour / 10-min reminders for the day's earliest start.
    // Reset first: if this is an EDIT (start time moved), cancel the previously
    // scheduled reminders + drop their claims so fresh, correctly-timed ones are
    // queued instead of the old ones firing at the wrong time.
    await resetClockReminder(employeeId, workDate);
    await scheduleAllReminders(employeeId, workDate, shifts[0].jobs.map((j) => j.start), emp, oc.name, link);
  } catch (err) {
    console.warn("[field-ops] shift assignment email failed:", err);
  }
}

/* ── 2b. Marked-off notice (Katie/Karan 2026-08) ──────────────────────────────
 * When a crew member who was ALREADY SCHEDULED gets marked off (sick / PTO /
 * etc.), email them the reason so they know not to come in. Only fires when they
 * actually had a shift that day — pre-planning a future PTO day they weren't
 * scheduled for stays silent. Respects opt-out + missing-email. Bilingual. */
export async function sendAbsenceNotice(
  employeeId: string,
  workDate: string,
  type: string,
  hours: number | null
): Promise<void> {
  try {
    const sb = commercialDb();
    // Only notify if they were actually on the schedule that day.
    const { data: assigns } = await sb
      .from("commercial_assignments")
      .select("id")
      .eq("employee_id", employeeId)
      .eq("work_date", workDate)
      .neq("status", "cancelled")
      .limit(1);
    if (!assigns || assigns.length === 0) return;
    const { data: e } = await sb
      .from("commercial_employees")
      .select("first_name, email, preferred_language, schedule_email_opt_out")
      .eq("id", employeeId)
      .eq("active", true)
      .maybeSingle();
    const emp = e as { first_name: string; email: string | null; preferred_language: "en" | "es"; schedule_email_opt_out: boolean } | null;
    if (!emp || !emp.email || emp.schedule_email_opt_out) return;
    const oc = await getOperatingCompany();
    const es = emp.preferred_language === "es";
    const reason = absenceLabel(type);
    const day = dayLabel(workDate, es);
    const partial = hours != null && hours > 0;
    const subject = es ? `Marcado ausente — ${day}` : `You're marked off — ${day}`;
    const text = es
      ? `Hola ${emp.first_name},\n\nEstas marcado como ausente el ${day}${partial ? ` por ${hours} horas` : ""} (${reason}). ${partial ? "No necesitas trabajar esas horas." : "No necesitas venir ese dia."}\n\nSi crees que es un error, contacta a la oficina.\n\n- ${oc.name}`
      : `Hi ${emp.first_name},\n\nYou're marked off for ${day}${partial ? ` for ${hours} hours` : ""} (${reason}). ${partial ? "You don't need to work those hours." : "You don't need to come in that day."}\n\nIf you think this is a mistake, contact the office.\n\n- ${oc.name}`;
    const { sendEmail } = await import("@/lib/email/resend");
    await sendEmail({
      channel: "commercial",
      to: emp.email,
      subject,
      text,
      ...(fromLine(oc.name) ? { from: fromLine(oc.name) } : {}),
      tags: [{ name: "kind", value: "crew_marked_off" }],
    });
  } catch (err) {
    console.warn("[field-ops] absence notice failed:", err);
  }
}

/* ── 4. Pre-shift reminders (1 day / 1 hour / 10 min before, Resend scheduled) ── */

async function scheduleReminder(
  employeeId: string,
  workDate: string,
  startTime: string,
  emp: { first_name: string; email: string | null; preferred_language: "en" | "es" },
  ocName: string,
  link: string,
  kind: ReminderKind,
  leadMin: number
): Promise<void> {
  if (!emp.email) return;
  const startUtc = etWallTimeToUtcIso(workDate, startTime);
  if (!startUtc) return;
  const fireAt = new Date(Date.parse(startUtc) - leadMin * 60_000).toISOString();
  if (Date.parse(fireAt) <= Date.now()) return; // too late for this lead
  // Already punched in that ET day? Don't remind a painter who's already clocked
  // in — this survives a same-day schedule re-save that would otherwise re-arm a
  // cancelled reminder (audit round 5). Punch-existence, not the log row.
  if (await hasPunchedThatDay(employeeId, workDate)) return;
  const claimId = await claimSend(employeeId, workDate, kind);
  if (!claimId) return; // already scheduled
  const es = emp.preferred_language === "es";
  const { subject, text } = reminderCopy(kind, emp.first_name, workDate, startTime, link, ocName, es);
  const { sendEmail } = await import("@/lib/email/resend");
  const sent = await sendEmail({
    channel: "commercial",
    to: emp.email,
    subject,
    text,
    scheduledAt: fireAt,
    ...(fromLine(ocName) ? { from: fromLine(ocName) } : {}),
    tags: [{ name: "kind", value: `crew_${kind}` }],
  });
  if (sent.ok) {
    // Store the Resend id so a later start-time change can cancel this exact
    // scheduled send (see resetClockReminder). id may be null (accepted w/o id).
    // Also stamp sent_at = the FIRE time (this column isn't read as an
    // actually-sent time anywhere) so resetClockReminder can tell a nudge that
    // has already fired (can't double-send → safe to clear) from one still pending
    // (audit round 11).
    await commercialDb()
      .from("commercial_schedule_email_log")
      .update({ resend_message_id: sent.id ?? null, sent_at: fireAt })
      .eq("id", claimId);
  } else {
    // Scheduling failed — release the claim so a later run reschedules it.
    await releaseClaim(employeeId, workDate, kind);
  }
}

/* ── 3+4+5. Daily orchestrator (called by the commercial-daily cron) ───────── */

export async function runDailyScheduleEmails(): Promise<{ dayOf: number; reminders: number; weekly: number; office: number }> {
  const sb = commercialDb();
  const today = todayEtIso();
  const tomorrow = addDaysIso(today, 1);
  const isSunday = dowOf(today) === 0;
  const oc = await getOperatingCompany();
  const fromHdr = fromLine(oc.name);
  const { sendEmail } = await import("@/lib/email/resend");

  const { data: empRows } = await sb
    .from("commercial_employees")
    .select("id, first_name, email, preferred_language, magic_link_token")
    .eq("active", true)
    .eq("schedule_email_opt_out", false);
  const emps = (empRows ?? []) as { id: string; first_name: string; email: string | null; preferred_language: "en" | "es"; magic_link_token: string | null }[];

  let dayOf = 0;
  let reminders = 0;
  let weekly = 0;

  for (const e of emps) {
    if (!e.email) continue;
    const es = e.preferred_language === "es";
    const link = magicLink(e.magic_link_token);

    // DAY-OF: today's shift.
    const todayShifts = await getShiftsForRange(e.id, today, 1);
    if (todayShifts.length > 0 && (await claimSend(e.id, today, "day_of"))) {
      const lines: string[] = [
        es ? `Hola ${e.first_name},` : `Hi ${e.first_name},`,
        "",
        es ? "Tu trabajo de hoy:" : "Today's work:",
        "",
        ...(await (async () => {
          const sc = await scopesFor(todayShifts);
          return todayShifts[0].jobs.map((j) =>
            shiftLine(j, es, j.opportunityId ? sc.get(scopeKey(j)) : null)
          );
        })()),
        "",
        es ? "Marca entrada/salida aqui:" : "Clock in/out here:",
        link,
        "",
        `- ${oc.name}`,
      ];
      try {
        const sent = await sendEmail({
          channel: "commercial",
          to: e.email,
          subject: es ? "Tu trabajo de hoy" : "Your schedule today",
          text: lines.join("\n"),
          ...(fromHdr ? { from: fromHdr } : {}),
          tags: [{ name: "kind", value: "crew_day_of" }],
        });
        if (!sent || sent.ok === false) {
          console.warn(`[field-ops] schedule email not sent to ${e.email}`);
          await releaseClaim(e.id, today, "day_of");
        } else {
          dayOf++;
        }
      } catch (err) {
        console.warn(`[field-ops] day-of email failed for ${e.email}:`, err);
        // Release the claim so a retry (or the next run) can re-fire — a transient
        // Resend failure must not permanently suppress today's schedule email.
        await releaseClaim(e.id, today, "day_of");
      }
    }

    // PRE-SHIFT REMINDERS: today's + tomorrow's shifts, all three leads (1-day,
    // 1-hour, 10-min). scheduleReminder claims (employee, date, kind) and only
    // sends if unclaimed, so this backfills any reminder not already scheduled at
    // add-time (e.g. a shift created before this feature, or whose add-time send
    // failed). Each kind's earliestNudgeableStart honors its own lead, and the
    // (start − lead ≤ now) skip lives inside scheduleReminder.
    for (const d of [today, tomorrow]) {
      const shifts = await getShiftsForRange(e.id, d, 1);
      if (shifts.length === 0) continue;
      const starts = shifts[0].jobs.map((j) => j.start);
      for (const r of REMINDERS) {
        if (await claimExists(e.id, d, r.kind)) continue;
        const s = earliestNudgeableStart(d, starts, r.leadMin);
        if (!s) continue;
        await scheduleReminder(e.id, d, s, e, oc.name, link, r.kind, r.leadMin).catch(() => undefined);
        reminders++;
      }
    }

    // WEEKLY (Sundays): the week ahead (Mon-Sat), deduped on next Monday's date.
    if (isSunday) {
      const weekStart = addDaysIso(today, 1); // Monday
      const week = await getShiftsForRange(e.id, weekStart, 7); // full Mon–Sun (incl. Sunday PW shifts)
      if (week.length > 0 && (await claimSend(e.id, weekStart, "weekly"))) {
        try {
          // sendEmail RESOLVES with {ok:false} on failure — it does not throw — so the

          // catch below never ran and releaseClaim was never called. A transient

          // Resend outage therefore marked the crew's schedule email as sent and

          // suppressed it permanently: nobody was told where to be, and nothing

          // anywhere said so.

          const sent = await sendEmail({
            channel: "commercial",
            to: e.email,
            subject: es ? "Tu horario de esta semana" : "Your schedule this week",
            text: buildBody(e.first_name, week, link, oc.name, es, await scopesFor(week)),
            ...(fromHdr ? { from: fromHdr } : {}),
            tags: [{ name: "kind", value: "crew_weekly" }],
          });
          if (!sent || sent.ok === false) {
            console.warn(`[field-ops] schedule email not sent to ${e.email}`);
            // weekStart, not today. The weekly send CLAIMS on weekStart (next
          // Monday); releasing on today (Sunday) deletes a row that was never
          // inserted, so the claim survives and that week's email stays
          // suppressed — the exact failure this branch was added to prevent.
          await releaseClaim(e.id, weekStart, "weekly");
          } else {
            weekly++;
          }
        } catch (err) {
          console.warn(`[field-ops] weekly email failed for ${e.email}:`, err);
          await releaseClaim(e.id, weekStart, "weekly");
        }
      }
    }
  }

  // OFFICE recipients: a daily "who's on today" digest, + the full week ahead on Sundays.
  const recipients = await listScheduleRecipients();
  let office = 0;
  if (recipients.length > 0) {
    const digest = await buildOfficeDigest(emps, today, isSunday);
    if (digest) {
      for (const r of recipients) {
        try {
          const sent = await sendEmail({
            channel: "commercial",
            to: r.email,
            subject: isSunday ? "Crew schedule - today + week ahead" : "Crew schedule - today",
            text: digest,
            ...(fromHdr ? { from: fromHdr } : {}),
            tags: [{ name: "kind", value: "office_schedule_daily" }],
          });
          office++;
        } catch (err) {
          console.warn(`[field-ops] office email failed for ${r.email}:`, err);
        }
      }
    }
  }

  return { dayOf, reminders, weekly, office };
}

async function buildOfficeDigest(
  emps: { id: string; first_name: string }[],
  today: string,
  isSunday: boolean
): Promise<string | null> {
  const todayLines: string[] = [`Today - ${dayLabel(today, false)}`, ""];
  let anyToday = false;
  for (const e of emps) {
    const shifts = await getShiftsForRange(e.id, today, 1);
    if (shifts.length === 0) continue;
    anyToday = true;
    const parts = shifts[0].jobs.map((j) => {
      const times = j.start ? `${fmtTime12(j.start)}${j.end ? `-${fmtTime12(j.end)}` : ""}` : `${j.hours}h`;
      return `${j.name} (${times})`;
    });
    todayLines.push(`  ${e.first_name}: ${parts.join(", ")}`);
  }
  if (!anyToday) todayLines.push("  (nobody scheduled today)");

  if (!isSunday) return anyToday ? todayLines.join("\n") : null;

  // Sunday: append the full week ahead.
  const weekStart = addDaysIso(today, 1);
  const weekLines: string[] = ["", "", `Week ahead - starting ${dayLabel(weekStart, false)}`, ""];
  let anyWeek = false;
  for (const e of emps) {
    const week = await getShiftsForRange(e.id, weekStart, 7); // full Mon–Sun
    if (week.length === 0) continue;
    anyWeek = true;
    weekLines.push(e.first_name);
    for (const d of week) weekLines.push(`  ${dayLabel(d.date, false)}: ${d.jobs.map((j) => `${j.name} ${j.hours}h`).join(", ")}`);
    weekLines.push("");
  }
  // Nothing today and nothing next week -> don't send an empty Sunday digest.
  if (!anyToday && !anyWeek) return null;
  return [...todayLines, ...(anyWeek ? weekLines : [])].join("\n");
}
