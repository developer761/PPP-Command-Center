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
async function syncTimeEntry(employeeId: string, jobId: string, dateIso: string, actorNote: string): Promise<void> {
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
  const withinThreshold = scheduled != null && Math.abs(rounded - scheduled) <= AUTO_APPROVE_THRESHOLD_HOURS;

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

export async function clockIn(input: {
  employee_id: string;
  job_id: string;
  assignment_id?: string | null;
  source?: "self_link" | "kiosk" | "foreman" | "admin";
  actor_note?: string;
}): Promise<{ ok: true; punchId: string } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: open } = await sb
    .from("commercial_time_punches")
    .select("id, job_id")
    .eq("employee_id", input.employee_id)
    .is("clock_out_at", null)
    .maybeSingle();
  if (open) return { ok: false, error: "You're already clocked in - clock out first." };

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
    if (/duplicate key|unique/i.test(error.message)) return { ok: false, error: "You're already clocked in - clock out first." };
    return { ok: false, error: error.message };
  }
  await logInsert("commercial_time_punches", (data as { id: string }).id, data, input.employee_id);
  return { ok: true, punchId: (data as { id: string }).id };
}

export async function clockOut(input: {
  employee_id: string;
  source?: "self_link" | "kiosk" | "foreman" | "admin";
}): Promise<{ ok: true; jobId: string } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: open } = await sb
    .from("commercial_time_punches")
    .select("id, job_id, clock_in_at")
    .eq("employee_id", input.employee_id)
    .is("clock_out_at", null)
    .maybeSingle();
  if (!open) return { ok: false, error: "You're not clocked in." };

  const punch = open as { id: string; job_id: string; clock_in_at: string };
  const now = new Date().toISOString();
  const { data: updated, error } = await sb
    .from("commercial_time_punches")
    .update({ clock_out_at: now })
    .eq("id", punch.id)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  await logUpdate("commercial_time_punches", punch.id, open, updated, input.employee_id);

  // Roll the day's actuals for that job (ET work day, not the UTC date).
  const workDate = etDate(punch.clock_in_at);
  await syncTimeEntry(input.employee_id, punch.job_id, workDate, "clock-out");
  return { ok: true, jobId: punch.job_id };
}
