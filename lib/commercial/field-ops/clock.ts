import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate } from "@/lib/commercial/audit-log";
import { addDaysIso } from "./schedule";
import { AUTO_APPROVE_THRESHOLD_HOURS } from "./approvals";
import type { CommercialEmployee } from "./employees";

/** The America/New_York calendar date a timestamp falls on (payroll work day). */
function etDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/**
 * R10.3 Clock in/out. Painters clock via their magic link (no login) or the
 * Clock Station kiosk. Punches are the raw events (server timestamps); the day's
 * time_entry.actual_hours is the sum of that employee/job/date's punches. The DB
 * enforces one OPEN punch per employee (can't be on two jobs at once).
 */

const EMP_COLS =
  "id, first_name, last_name, display_name, worker_type, role, pay_type, default_daily_hours, phone, email, sort_order, active, start_date, end_date, schedule_email_opt_out, preferred_language, external_ref, created_at, updated_at";

export async function getEmployeeByToken(token: string): Promise<CommercialEmployee | null> {
  if (!token || token.length < 16) return null;
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_employees")
    .select(EMP_COLS)
    .eq("magic_link_token", token)
    .eq("active", true)
    .maybeSingle();
  return (data as CommercialEmployee | null) ?? null;
}

export type TodayAssignment = {
  assignment_id: string;
  job_id: string;
  job_name: string;
  job_code: string;
  prevailing_wage: boolean;
  site: string | null;
  scheduled_hours: number;
  scheduled_start_time: string | null;
};

export type OpenPunch = { id: string; job_id: string; job_name: string; clock_in_at: string };

export type EmployeeDay = {
  date: string;
  assignments: TodayAssignment[];
  openPunch: OpenPunch | null;
  hoursByJob: Record<string, number>; // job_id -> actual hours clocked today
};

export async function getEmployeeDay(employeeId: string, dateIso: string): Promise<EmployeeDay> {
  const sb = commercialDb();
  const [aRes, pRes] = await Promise.all([
    sb
      .from("commercial_assignments")
      .select("id, job_id, scheduled_hours, scheduled_start_time")
      .eq("employee_id", employeeId)
      .eq("work_date", dateIso)
      .neq("status", "cancelled"),
    sb
      .from("commercial_time_punches")
      .select("id, job_id, clock_in_at, clock_out_at")
      .eq("employee_id", employeeId)
      // Widen to a UTC window around the ET day, then filter by ET date below
      // (the ET day straddles two UTC dates, esp. for evening punches).
      .gte("clock_in_at", `${addDaysIso(dateIso, -1)}T00:00:00Z`)
      .lte("clock_in_at", `${addDaysIso(dateIso, 1)}T23:59:59Z`)
      .order("clock_in_at", { ascending: true }),
  ]);

  const assigns = (aRes.data ?? []) as { id: string; job_id: string; scheduled_hours: number; scheduled_start_time: string | null }[];
  const punches = ((pRes.data ?? []) as { id: string; job_id: string; clock_in_at: string; clock_out_at: string | null }[]).filter(
    (p) => etDate(p.clock_in_at) === dateIso
  );

  // Any open punch (from any day) - a painter can't have two open at once.
  const { data: openRow } = await sb
    .from("commercial_time_punches")
    .select("id, job_id, clock_in_at")
    .eq("employee_id", employeeId)
    .is("clock_out_at", null)
    .maybeSingle();

  const jobIds = [...new Set([...assigns.map((a) => a.job_id), ...punches.map((p) => p.job_id), ...(openRow ? [(openRow as { job_id: string }).job_id] : [])])];
  const jobsById = new Map<string, { id: string; name: string; job_code: string; prevailing_wage: boolean; site_address: string | null; site_city: string | null }>();
  if (jobIds.length > 0) {
    const { data: jobs } = await sb
      .from("commercial_jobs")
      .select("id, name, job_code, prevailing_wage, site_address, site_city")
      .in("id", jobIds);
    for (const j of (jobs ?? []) as { id: string; name: string; job_code: string; prevailing_wage: boolean; site_address: string | null; site_city: string | null }[]) jobsById.set(j.id, j);
  }

  const hoursByJob: Record<string, number> = {};
  for (const p of punches) {
    if (!p.clock_out_at) continue;
    const hrs = (new Date(p.clock_out_at).getTime() - new Date(p.clock_in_at).getTime()) / 3_600_000;
    hoursByJob[p.job_id] = (hoursByJob[p.job_id] ?? 0) + Math.max(0, hrs);
  }

  const assignments: TodayAssignment[] = assigns.map((a) => {
    const j = jobsById.get(a.job_id);
    return {
      assignment_id: a.id,
      job_id: a.job_id,
      job_name: j?.name ?? "(job)",
      job_code: j?.job_code ?? "",
      prevailing_wage: j?.prevailing_wage ?? false,
      site: [j?.site_address, j?.site_city].filter(Boolean).join(", ") || null,
      scheduled_hours: a.scheduled_hours,
      scheduled_start_time: a.scheduled_start_time,
    };
  });

  const openPunch: OpenPunch | null = openRow
    ? {
        id: (openRow as { id: string }).id,
        job_id: (openRow as { job_id: string }).job_id,
        job_name: jobsById.get((openRow as { job_id: string }).job_id)?.name ?? "(job)",
        clock_in_at: (openRow as { clock_in_at: string }).clock_in_at,
      }
    : null;

  return { date: dateIso, assignments, openPunch, hoursByJob };
}

/** Recompute the daily time_entry for one (employee, job, date) from its closed
 *  punches. Upserts on UNIQUE(employee, job, date). Marks source 'clocked'. */
async function syncTimeEntry(
  employeeId: string,
  jobId: string,
  dateIso: string,
  actorNote: string,
  opts?: { forceReview?: boolean },
): Promise<void> {
  const sb = commercialDb();
  const { data: punchRows } = await sb
    .from("commercial_time_punches")
    .select("clock_in_at, clock_out_at, assignment_id")
    .eq("employee_id", employeeId)
    .eq("job_id", jobId)
    .gte("clock_in_at", `${addDaysIso(dateIso, -1)}T00:00:00Z`)
    .lte("clock_in_at", `${addDaysIso(dateIso, 1)}T23:59:59Z`);
  const punches = ((punchRows ?? []) as { clock_in_at: string; clock_out_at: string | null; assignment_id: string | null }[]).filter(
    (p) => etDate(p.clock_in_at) === dateIso
  );
  let total = 0;
  let assignmentId: string | null = null;
  for (const p of punches) {
    if (p.assignment_id) assignmentId = p.assignment_id;
    if (!p.clock_out_at) continue;
    total += Math.max(0, (new Date(p.clock_out_at).getTime() - new Date(p.clock_in_at).getTime()) / 3_600_000);
  }
  const rounded = Math.round(total * 4) / 4; // nearest quarter hour

  // Scheduled hours for this employee/job/day (the assignment). Drives the
  // 30-min auto-approve: clocked within ±0.5h of scheduled clears itself; a
  // bigger gap (or no schedule to compare) goes to Approvals for review.
  const { data: aRow } = await sb
    .from("commercial_assignments")
    .select("scheduled_hours")
    .eq("employee_id", employeeId)
    .eq("job_id", jobId)
    .eq("work_date", dateIso)
    .neq("status", "cancelled")
    .maybeSingle();
  const scheduled = (aRow as { scheduled_hours?: number } | null)?.scheduled_hours ?? null;
  // A force-closed (missed clock-out) entry is a CAPPED GUESS, never a real
  // clock-out — it must always land in Approvals for a manager, never auto-approve.
  const withinThreshold =
    !opts?.forceReview && scheduled != null && Math.abs(rounded - scheduled) <= AUTO_APPROVE_THRESHOLD_HOURS;

  const { data: existing } = await sb
    .from("commercial_time_entries")
    .select("id, status, source, approved_by_user_id")
    .eq("employee_id", employeeId)
    .eq("job_id", jobId)
    .eq("work_date", dateIso)
    .maybeSingle();

  if (existing) {
    const cur = existing as { id: string; status: string; source: string; approved_by_user_id: string | null };
    // Never clobber a human decision: a manually-set (source='manual'),
    // human-approved (approved_by set), or questioned entry keeps BOTH its hours
    // and its status — a later clock-out must not silently overwrite a manager's
    // correction. Only system-auto/still-submitted clocked entries are recomputed.
    const humanTouched =
      cur.source === "manual" ||
      cur.status === "questioned" ||
      (cur.status === "approved" && !!cur.approved_by_user_id);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (!humanTouched) {
      patch.actual_hours = rounded;
      patch.source = "clocked";
      if (withinThreshold) {
        patch.status = "approved";
        patch.approved_by_user_id = null; // system auto-approval
        patch.approved_at = new Date().toISOString();
      } else {
        patch.status = "submitted";
        patch.approved_at = null;
      }
    }
    await sb.from("commercial_time_entries").update(patch).eq("id", cur.id);
  } else if (rounded > 0) {
    await sb.from("commercial_time_entries").insert({
      employee_id: employeeId,
      job_id: jobId,
      work_date: dateIso,
      assignment_id: assignmentId,
      actual_hours: rounded,
      source: "clocked",
      status: withinThreshold ? "approved" : "submitted",
      submitted_at: new Date().toISOString(),
      ...(withinThreshold ? { approved_at: new Date().toISOString() } : {}),
    });
  }
}

/** Never attribute more than a long shift to a forgotten punch. */
const STALE_PUNCH_CAP_HOURS = 12;

/**
 * Force-close a punch left open (missed clock-out). Without this, the worked day
 * records ZERO paid hours (a time_entry is only written on a real clock-out) AND
 * the stale punch blocks the painter's next-day clock-in. Caps the paid span at
 * the scheduled hours (fallback 8h, hard max 12h) so a forgotten punch never
 * balloons into a ~24h entry, files it as a time_entry FLAGGED FOR REVIEW (never
 * auto-approved — the hours are a guess), and stamps an audit note. Returns true
 * if it closed the punch (false if a concurrent real clock-out beat it).
 */
async function forceCloseStalePunch(
  sb: ReturnType<typeof commercialDb>,
  punch: { id: string; employee_id: string; job_id: string; clock_in_at: string; note: string | null },
): Promise<boolean> {
  const workDate = etDate(punch.clock_in_at);
  const { data: aRow } = await sb
    .from("commercial_assignments")
    .select("scheduled_hours")
    .eq("employee_id", punch.employee_id)
    .eq("job_id", punch.job_id)
    .eq("work_date", workDate)
    .neq("status", "cancelled")
    .maybeSingle();
  const scheduled = (aRow as { scheduled_hours?: number } | null)?.scheduled_hours ?? null;
  const capHours = Math.min(scheduled && scheduled > 0 ? scheduled : 8, STALE_PUNCH_CAP_HOURS);
  const inMs = new Date(punch.clock_in_at).getTime();
  const outIso = new Date(Math.min(inMs + capHours * 3_600_000, Date.now())).toISOString();
  const note = [punch.note, "[auto-closed: missed clock-out — hours capped, needs review]"].filter(Boolean).join(" ");
  const { data: before } = await sb.from("commercial_time_punches").select("*").eq("id", punch.id).maybeSingle();
  const { data: updated } = await sb
    .from("commercial_time_punches")
    .update({ clock_out_at: outIso, note })
    .eq("id", punch.id)
    .is("clock_out_at", null) // race guard: a concurrent real clock-out wins
    .select("*")
    .maybeSingle();
  if (!updated) return false;
  await logUpdate("commercial_time_punches", punch.id, before, updated, punch.employee_id);
  await syncTimeEntry(punch.employee_id, punch.job_id, workDate, "auto-close", { forceReview: true });
  return true;
}

/**
 * Daily-cron sweep: force-close every punch left open past a full shift. Keeps a
 * missed clock-out from silently zeroing a worked day and from blocking tomorrow's
 * clock-in. Idempotent — a punch closed on a prior run no longer matches.
 */
export async function closeStalePunches(): Promise<{ closed: number }> {
  const sb = commercialDb();
  const cutoff = new Date(Date.now() - STALE_PUNCH_CAP_HOURS * 3_600_000).toISOString();
  const { data: rows } = await sb
    .from("commercial_time_punches")
    .select("id, employee_id, job_id, clock_in_at, note")
    .is("clock_out_at", null)
    .lt("clock_in_at", cutoff);
  const punches = (rows ?? []) as { id: string; employee_id: string; job_id: string; clock_in_at: string; note: string | null }[];
  let closed = 0;
  for (const p of punches) {
    if (await forceCloseStalePunch(sb, p)) closed += 1;
  }
  return { closed };
}

export async function clockIn(input: {
  employee_id: string;
  job_id: string;
  assignment_id?: string | null;
  source?: "self_link" | "kiosk" | "foreman" | "admin";
  actor_note?: string;
}): Promise<{ ok: true; punchId: string } | { ok: false; error: string; code?: string }> {
  const sb = commercialDb();
  const { data: open } = await sb
    .from("commercial_time_punches")
    .select("id, job_id, clock_in_at, note")
    .eq("employee_id", input.employee_id)
    .is("clock_out_at", null)
    .maybeSingle();
  if (open) {
    const openPunch = open as { id: string; job_id: string; clock_in_at: string; note: string | null };
    const todayEt = etDate(new Date().toISOString());
    if (etDate(openPunch.clock_in_at) === todayEt) {
      // A genuine open punch from TODAY — keep the hard block.
      return { ok: false, error: "You're already clocked in - clock out first.", code: "already_clocked_in" };
    }
    // A stale punch from a PRIOR ET day (missed clock-out). Force-close it
    // (capped + flagged for review) so this painter can clock into today's job
    // instead of being locked out — never leave a worked day at 0 hours.
    await forceCloseStalePunch(sb, { ...openPunch, employee_id: input.employee_id });
  }

  const { data, error } = await sb
    .from("commercial_time_punches")
    .insert({
      employee_id: input.employee_id,
      job_id: input.job_id,
      assignment_id: input.assignment_id ?? null,
      clock_in_at: new Date().toISOString(),
      source: input.source ?? "self_link",
      note: input.actor_note ?? null,
    })
    .select("id")
    .single();
  if (error) {
    // 23505 = the one-open-punch partial unique fired on a race.
    if (/duplicate key|unique/i.test(error.message)) return { ok: false, error: "You're already clocked in - clock out first.", code: "already_clocked_in" };
    return { ok: false, error: error.message, code: "clock_failed" };
  }
  await logInsert("commercial_time_punches", (data as { id: string }).id, data, input.employee_id);
  return { ok: true, punchId: (data as { id: string }).id };
}

export async function clockOut(input: {
  employee_id: string;
  source?: "self_link" | "kiosk" | "foreman" | "admin";
}): Promise<{ ok: true; jobId: string } | { ok: false; error: string; code?: string }> {
  const sb = commercialDb();
  const { data: open } = await sb
    .from("commercial_time_punches")
    .select("id, job_id, clock_in_at, note")
    .eq("employee_id", input.employee_id)
    .is("clock_out_at", null)
    .maybeSingle();
  if (!open) return { ok: false, error: "You're not clocked in.", code: "not_clocked_in" };

  const punch = open as { id: string; job_id: string; clock_in_at: string; note: string | null };
  const nowIso = new Date().toISOString();
  // A forgotten clock-out from a PRIOR ET day (or an impossibly long span) must
  // never record raw elapsed hours — that would write a ~24h shift the moment the
  // painter taps "Clock Out" the next morning (before the daily sweep runs). Route
  // it through the SAME capped + flagged-for-review path as the clock-in stale
  // guard and the cron sweep, so no close path can write an uncapped >12h entry
  // (audit 2026-08).
  const spanHours = (Date.parse(nowIso) - Date.parse(punch.clock_in_at)) / 3_600_000;
  if (etDate(punch.clock_in_at) !== etDate(nowIso) || spanHours > STALE_PUNCH_CAP_HOURS) {
    await forceCloseStalePunch(sb, { ...punch, employee_id: input.employee_id });
    return { ok: true, jobId: punch.job_id };
  }

  const { data: updated, error } = await sb
    .from("commercial_time_punches")
    .update({ clock_out_at: nowIso })
    .eq("id", punch.id)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message, code: "clock_failed" };
  await logUpdate("commercial_time_punches", punch.id, open, updated, input.employee_id);

  // Roll the day's actuals for that job (ET work day, not the UTC date).
  const workDate = etDate(punch.clock_in_at);
  await syncTimeEntry(input.employee_id, punch.job_id, workDate, "clock-out");
  return { ok: true, jobId: punch.job_id };
}
