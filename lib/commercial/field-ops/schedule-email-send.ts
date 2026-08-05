import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { addDaysIso, todayEtIso, etWallTimeToUtcIso, fmtTime12 } from "./schedule";
import { listScheduleRecipients } from "./schedule-emails";
import type { CommercialEmployee } from "./employees";

/**
 * R10.7 - painter schedule emails. Cadence:
 *   1. WELCOME — instant on add (their magic link, so they can clock in day one).
 *   2. SHIFT — instant whenever they're placed on the Calendar (the day's shifts
 *      + times + the note the scheduler wrote), and schedules their clock-in nudge.
 *   3. DAY-OF — each morning, today's shift (a change is never missed).
 *   4. CLOCK-IN NUDGE — 10 min before their first start time, via Resend's
 *      scheduled send (no minute-by-minute cron needed).
 *   5. WEEKLY — every Sunday, the full week ahead.
 * Office recipients get a daily "who's on today" digest + the Sunday week-ahead.
 * All crew mail is bilingual (en/es) and respects schedule_email_opt_out.
 * A per-(employee, date, kind) log makes the daily run idempotent.
 */

const CLOCK_LEAD_MIN = 10;

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

type Shift = { name: string; site: string | null; hours: number; pw: boolean; start: string | null; end: string | null; note: string | null };
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
  const jobIds = [...new Set(assigns.map((a) => a.job_id))];
  const jobsById = new Map<string, { name: string; site_address: string | null; site_city: string | null; prevailing_wage: boolean }>();
  const { data: jobs } = await sb.from("commercial_jobs").select("id, name, site_address, site_city, prevailing_wage").in("id", jobIds);
  for (const j of (jobs ?? []) as { id: string; name: string; site_address: string | null; site_city: string | null; prevailing_wage: boolean }[])
    jobsById.set(j.id, j);

  const byDate = new Map<string, UpDay>();
  for (let i = 0; i < numDays; i++) {
    const d = addDaysIso(fromIso, i);
    const dayAssigns = assigns
      .filter((a) => a.work_date === d)
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
        };
      }),
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function shiftLine(j: Shift, es: boolean): string {
  const pw = es ? "salario prevaleciente" : "prevailing wage";
  const times = j.start ? `${fmtTime12(j.start)}${j.end ? `-${fmtTime12(j.end)}` : ""}` : `${j.hours}h`;
  let line = `  - ${j.name}${j.site ? ` (${j.site})` : ""} - ${times}${j.pw ? ` [${pw}]` : ""}`;
  if (j.note) line += `\n      ${es ? "Nota" : "Note"}: ${j.note}`;
  return line;
}

function buildBody(firstName: string, upcoming: UpDay[], link: string, ocName: string, es: boolean): string {
  const L = es
    ? { hi: `Hola ${firstName},`, intro: "Aqui esta tu horario:", none: "No tienes trabajos programados todavia.", cta: "Abre esto en tu telefono para ver tu horario y marcar entrada/salida:" }
    : { hi: `Hi ${firstName},`, intro: "Here's your schedule:", none: "No jobs scheduled for you yet.", cta: "Open this on your phone to see your schedule and clock in/out:" };
  const lines: string[] = [L.hi, "", L.intro, ""];
  if (upcoming.length === 0) lines.push(L.none, "");
  else
    for (const d of upcoming) {
      lines.push(dayLabel(d.date, es));
      for (const j of d.jobs) lines.push(shiftLine(j, es));
      lines.push("");
    }
  lines.push(L.cta, link, "", `- ${ocName}`);
  return lines.join("\n");
}

/* ── dedup log — claim-before-send so a cron retry never double-fires ──────── */

/** Atomically claim (employee, date, kind). Returns true if WE claimed it (so we
 *  should send), false if it was already claimed. The UNIQUE constraint is the
 *  real guard — safe even if two cron runs overlap. */
async function claimSend(employeeId: string, workDate: string, kind: "day_of" | "clock_reminder" | "weekly"): Promise<boolean> {
  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_schedule_email_log")
    .insert({ employee_id: employeeId, work_date: workDate, kind })
    .select("id")
    .single();
  return !error; // error (incl. unique violation) => already claimed
}

/** Has (employee, date, kind) already been claimed/sent? Read-only check. */
async function claimExists(employeeId: string, workDate: string, kind: "day_of" | "clock_reminder" | "weekly"): Promise<boolean> {
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
    const { data: emp } = await sb.from("commercial_employees").select("magic_link_token").eq("id", employee.id).maybeSingle();
    const token = (emp as { magic_link_token?: string } | null)?.magic_link_token ?? null;
    const oc = await getOperatingCompany();
    const es = employee.preferred_language === "es";
    const link = magicLink(token);
    const upcoming = await getShiftsForRange(employee.id, todayEtIso(), 7);
    const intro = es
      ? `Hola ${employee.first_name},\n\nEstas registrado con ${oc.name}. Usa este enlace en tu telefono para ver tu horario y marcar entrada/salida cada dia - no necesitas contrasena. Guardalo en favoritos.`
      : `Hi ${employee.first_name},\n\nYou're set up with ${oc.name}. Use this link on your phone to see your schedule and clock in/out each day - no password needed. Bookmark it.`;
    const body = `${intro}\n\n${link}\n\n${upcoming.length > 0 ? buildBody(employee.first_name, upcoming, link, oc.name, es) : `- ${oc.name}`}`;
    const { sendEmail } = await import("@/lib/email/resend");
    await sendEmail({
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
    const oc = await getOperatingCompany();
    const es = emp.preferred_language === "es";
    const link = magicLink(emp.magic_link_token);
    const head = es
      ? `Hola ${emp.first_name},\n\nEstas programado para el ${dayLabel(workDate, true)}:`
      : `Hi ${emp.first_name},\n\nYou're scheduled for ${dayLabel(workDate, false)}:`;
    const lines: string[] = [head, ""];
    for (const j of shifts[0].jobs) lines.push(shiftLine(j, es));
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

    // Schedule the 10-min-before clock-in nudge for the day's earliest start.
    const firstStart = shifts[0].jobs.map((j) => j.start).filter(Boolean).sort()[0] ?? null;
    if (firstStart) await scheduleClockReminder(employeeId, workDate, firstStart, emp, oc.name, link);
  } catch (err) {
    console.warn("[field-ops] shift assignment email failed:", err);
  }
}

/* ── 4. Clock-in nudge (10 min before, Resend scheduled send) ──────────────── */

async function scheduleClockReminder(
  employeeId: string,
  workDate: string,
  startTime: string,
  emp: { first_name: string; email: string | null; preferred_language: "en" | "es" },
  ocName: string,
  link: string
): Promise<void> {
  if (!emp.email) return;
  const startUtc = etWallTimeToUtcIso(workDate, startTime);
  if (!startUtc) return;
  const fireAt = new Date(Date.parse(startUtc) - CLOCK_LEAD_MIN * 60_000).toISOString();
  if (Date.parse(fireAt) <= Date.now()) return; // too late to nudge
  if (!(await claimSend(employeeId, workDate, "clock_reminder"))) return; // already scheduled
  const es = emp.preferred_language === "es";
  const t = fmtTime12(startTime);
  const body = es
    ? `Hola ${emp.first_name},\n\nTu turno empieza a las ${t}. Toca aqui para marcar entrada (y salida cuando termines):\n\n${link}\n\n- ${ocName}`
    : `Hi ${emp.first_name},\n\nYour shift starts at ${t}. Tap here to clock in (and clock out when you finish):\n\n${link}\n\n- ${ocName}`;
  const { sendEmail } = await import("@/lib/email/resend");
  await sendEmail({
    channel: "commercial",
    to: emp.email,
    subject: es ? `Marca entrada - empieza a las ${t}` : `Clock in - shift starts at ${t}`,
    text: body,
    scheduledAt: fireAt,
    ...(fromLine(ocName) ? { from: fromLine(ocName) } : {}),
    tags: [{ name: "kind", value: "crew_clock_reminder" }],
  });
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
        ...todayShifts[0].jobs.map((j) => shiftLine(j, es)),
        "",
        es ? "Marca entrada/salida aqui:" : "Clock in/out here:",
        link,
        "",
        `- ${oc.name}`,
      ];
      try {
        await sendEmail({
          channel: "commercial",
          to: e.email,
          subject: es ? "Tu trabajo de hoy" : "Your schedule today",
          text: lines.join("\n"),
          ...(fromHdr ? { from: fromHdr } : {}),
          tags: [{ name: "kind", value: "crew_day_of" }],
        });
        dayOf++;
      } catch (err) {
        console.warn(`[field-ops] day-of email failed for ${e.email}:`, err);
      }
    }

    // CLOCK-IN NUDGES: today's remaining + tomorrow's shifts. scheduleClockReminder
    // claims (employee, date, 'clock_reminder') and only sends if unclaimed, so this
    // backfills any shift whose nudge wasn't already scheduled at add-time.
    for (const d of [today, tomorrow]) {
      const shifts = await getShiftsForRange(e.id, d, 1);
      const firstStart = shifts[0]?.jobs.map((j) => j.start).filter(Boolean).sort()[0] ?? null;
      if (!firstStart) continue;
      const alreadyScheduled = await claimExists(e.id, d, "clock_reminder");
      if (alreadyScheduled) continue;
      const startUtc = etWallTimeToUtcIso(d, firstStart);
      if (!startUtc || Date.parse(startUtc) - CLOCK_LEAD_MIN * 60_000 <= Date.now()) continue;
      await scheduleClockReminder(e.id, d, firstStart, e, oc.name, link).catch(() => undefined);
      reminders++;
    }

    // WEEKLY (Sundays): the week ahead (Mon-Sat), deduped on next Monday's date.
    if (isSunday) {
      const weekStart = addDaysIso(today, 1); // Monday
      const week = await getShiftsForRange(e.id, weekStart, 6);
      if (week.length > 0 && (await claimSend(e.id, weekStart, "weekly"))) {
        try {
          await sendEmail({
            channel: "commercial",
            to: e.email,
            subject: es ? "Tu horario de esta semana" : "Your schedule this week",
            text: buildBody(e.first_name, week, link, oc.name, es),
            ...(fromHdr ? { from: fromHdr } : {}),
            tags: [{ name: "kind", value: "crew_weekly" }],
          });
          weekly++;
        } catch (err) {
          console.warn(`[field-ops] weekly email failed for ${e.email}:`, err);
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
          await sendEmail({
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
    const week = await getShiftsForRange(e.id, weekStart, 6);
    if (week.length === 0) continue;
    anyWeek = true;
    weekLines.push(e.first_name);
    for (const d of week) weekLines.push(`  ${dayLabel(d.date, false)}: ${d.jobs.map((j) => `${j.name} ${j.hours}h`).join(", ")}`);
    weekLines.push("");
  }
  return [...todayLines, ...(anyWeek ? weekLines : [])].join("\n");
}
