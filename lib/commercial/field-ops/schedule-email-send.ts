import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { addDaysIso, todayEtIso } from "./schedule";
import { listScheduleRecipients } from "./schedule-emails";
import type { CommercialEmployee } from "./employees";

/**
 * R10.3 - painter schedule emails. Two triggers:
 *  1. Instant WELCOME on add (their magic link, so they can clock in day one).
 *  2. DAILY (each morning, via the commercial-daily cron) - the rolling week
 *     ahead, so a schedule change is never missed. Bilingual (en/es).
 * Office recipients get the full all-crew schedule on the daily run.
 */

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

type UpDay = { date: string; jobs: { name: string; site: string | null; hours: number; pw: boolean }[] };

async function getUpcoming(employeeId: string, fromIso: string, numDays: number): Promise<UpDay[]> {
  const sb = commercialDb();
  const toIso = addDaysIso(fromIso, numDays - 1);
  const { data: aRows } = await sb
    .from("commercial_assignments")
    .select("job_id, work_date, scheduled_hours")
    .eq("employee_id", employeeId)
    .gte("work_date", fromIso)
    .lte("work_date", toIso)
    .neq("status", "cancelled");
  const assigns = (aRows ?? []) as { job_id: string; work_date: string; scheduled_hours: number }[];
  if (assigns.length === 0) return [];
  const jobIds = [...new Set(assigns.map((a) => a.job_id))];
  const jobsById = new Map<string, { name: string; site_address: string | null; site_city: string | null; prevailing_wage: boolean }>();
  const { data: jobs } = await sb.from("commercial_jobs").select("id, name, site_address, site_city, prevailing_wage").in("id", jobIds);
  for (const j of (jobs ?? []) as { id: string; name: string; site_address: string | null; site_city: string | null; prevailing_wage: boolean }[])
    jobsById.set(j.id, j);

  const byDate = new Map<string, UpDay>();
  for (let i = 0; i < numDays; i++) {
    const d = addDaysIso(fromIso, i);
    const dayAssigns = assigns.filter((a) => a.work_date === d);
    if (dayAssigns.length === 0) continue;
    byDate.set(d, {
      date: d,
      jobs: dayAssigns.map((a) => {
        const j = jobsById.get(a.job_id);
        return { name: j?.name ?? "(job)", site: [j?.site_address, j?.site_city].filter(Boolean).join(", ") || null, hours: a.scheduled_hours, pw: j?.prevailing_wage ?? false };
      }),
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function buildBody(firstName: string, upcoming: UpDay[], link: string, ocName: string, es: boolean): string {
  const L = es
    ? { hi: `Hola ${firstName},`, intro: "Aqui esta tu horario:", none: "No tienes trabajos programados todavia.", cta: "Abre esto en tu telefono para ver tu horario y marcar entrada/salida:", pw: "salario prevaleciente" }
    : { hi: `Hi ${firstName},`, intro: "Here's your schedule:", none: "No jobs scheduled for you yet.", cta: "Open this on your phone to see your schedule and clock in/out:", pw: "prevailing wage" };
  const lines: string[] = [L.hi, "", L.intro, ""];
  if (upcoming.length === 0) lines.push(L.none, "");
  else
    for (const d of upcoming) {
      lines.push(dayLabel(d.date, es));
      for (const j of d.jobs) lines.push(`  - ${j.name}${j.site ? ` (${j.site})` : ""} - ${j.hours}h${j.pw ? ` [${L.pw}]` : ""}`);
      lines.push("");
    }
  lines.push(L.cta, link, "", `- ${ocName}`);
  return lines.join("\n");
}

/** Instant welcome email when a crew member is added (if they have an email). */
export async function sendWelcomeEmail(employee: CommercialEmployee): Promise<void> {
  if (!employee.email) return;
  try {
    const sb = commercialDb();
    const { data: emp } = await sb.from("commercial_employees").select("magic_link_token").eq("id", employee.id).maybeSingle();
    const token = (emp as { magic_link_token?: string } | null)?.magic_link_token ?? null;
    const oc = await getOperatingCompany();
    const es = employee.preferred_language === "es";
    const link = magicLink(token);
    const upcoming = await getUpcoming(employee.id, todayEtIso(), 7);
    const intro = es
      ? `Hola ${employee.first_name},\n\nEstas registrado con ${oc.name}. Usa este enlace en tu telefono para ver tu horario y marcar entrada/salida cada dia - no necesitas contrasena. Guardalo en favoritos.`
      : `Hi ${employee.first_name},\n\nYou're set up with ${oc.name}. Use this link on your phone to see your schedule and clock in/out each day - no password needed. Bookmark it.`;
    const body = `${intro}\n\n${link}\n\n${upcoming.length > 0 ? buildBody(employee.first_name, upcoming, link, oc.name, es) : ""}\n- ${oc.name}`;
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

/** Daily run (each morning). Emails every active, non-opted-out crew member with
 *  an email their rolling week ahead, and the office recipients the full crew
 *  schedule. Called from the commercial-daily cron. Returns a count. */
export async function sendDailyScheduleEmails(): Promise<{ crew: number; office: number }> {
  const sb = commercialDb();
  const from = todayEtIso();
  const oc = await getOperatingCompany();
  const fromHdr = fromLine(oc.name);

  const { data: empRows } = await sb
    .from("commercial_employees")
    .select("id, first_name, email, preferred_language, magic_link_token")
    .eq("active", true)
    .eq("schedule_email_opt_out", false);
  const emps = (empRows ?? []) as { id: string; first_name: string; email: string | null; preferred_language: "en" | "es"; magic_link_token: string | null }[];

  const { sendEmail } = await import("@/lib/email/resend");
  let crewSent = 0;
  for (const e of emps) {
    if (!e.email) continue;
    const upcoming = await getUpcoming(e.id, from, 7);
    if (upcoming.length === 0) continue; // nothing to miss -> no daily email
    const es = e.preferred_language === "es";
    const link = magicLink(e.magic_link_token);
    try {
      await sendEmail({
        channel: "commercial",
        to: e.email,
        subject: es ? "Tu horario de esta semana" : "Your schedule this week",
        text: buildBody(e.first_name, upcoming, link, oc.name, es),
        ...(fromHdr ? { from: fromHdr } : {}),
        tags: [{ name: "kind", value: "crew_schedule_daily" }],
      });
      crewSent++;
    } catch (err) {
      console.warn(`[field-ops] daily schedule email failed for ${e.email}:`, err);
    }
  }

  // Office recipients: the full crew schedule for the week ahead.
  const recipients = await listScheduleRecipients();
  let officeSent = 0;
  if (recipients.length > 0) {
    const allUpcoming: string[] = [`Crew schedule - week of ${dayLabel(from, false)}`, ""];
    let any = false;
    for (const e of emps) {
      const up = await getUpcoming(e.id, from, 7);
      if (up.length === 0) continue;
      any = true;
      allUpcoming.push(e.first_name);
      for (const d of up) {
        allUpcoming.push(`  ${dayLabel(d.date, false)}: ${d.jobs.map((j) => `${j.name} ${j.hours}h`).join(", ")}`);
      }
      allUpcoming.push("");
    }
    if (any) {
      for (const r of recipients) {
        try {
          await sendEmail({
            channel: "commercial",
            to: r.email,
            subject: "Crew schedule - week ahead",
            text: allUpcoming.join("\n"),
            ...(fromHdr ? { from: fromHdr } : {}),
            tags: [{ name: "kind", value: "office_schedule_daily" }],
          });
          officeSent++;
        } catch (err) {
          console.warn(`[field-ops] office schedule email failed for ${r.email}:`, err);
        }
      }
    }
  }

  return { crew: crewSent, office: officeSent };
}
