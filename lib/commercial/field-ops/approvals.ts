import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logUpdate } from "@/lib/commercial/audit-log";

/**
 * R10.4 Approvals - the pay-period variance review. Each time_entry is the
 * actual (clocked or manual) hours for an employee/job/day; the scheduled hours
 * come from the matching assignment. Scheduler/admin approves, questions (back to
 * the crew), or manually overrides the hours (Karan/Brendan's manual-edit).
 *
 * Clocked entries within AUTO_APPROVE_THRESHOLD_HOURS of scheduled auto-approve
 * at clock-out (see clock.ts) and never appear here — only the meaningful gaps
 * (>30 min) and manual entries land in this queue.
 */

/** Clock-vs-scheduled gap (hours) that auto-clears without review. 0.5 = 30 min. */
export const AUTO_APPROVE_THRESHOLD_HOURS = 0.5;

export type ApprovalRow = {
  id: string;
  employee_id: string;
  employee_name: string;
  job_id: string;
  job_name: string;
  work_date: string;
  scheduled: number | null;
  actual: number;
  variance: number | null; // actual - scheduled
  status: string;
  source: string;
  questioned_reason: string | null;
};

export async function listPendingApprovals(): Promise<ApprovalRow[]> {
  const sb = commercialDb();
  const { data: eRows } = await sb
    .from("commercial_time_entries")
    .select("id, employee_id, job_id, work_date, actual_hours, status, source, questioned_reason")
    .in("status", ["submitted", "questioned"])
    .order("work_date", { ascending: false });
  const entries = (eRows ?? []) as {
    id: string; employee_id: string; job_id: string; work_date: string; actual_hours: number; status: string; source: string; questioned_reason: string | null;
  }[];
  if (entries.length === 0) return [];

  const empIds = [...new Set(entries.map((e) => e.employee_id))];
  const jobIds = [...new Set(entries.map((e) => e.job_id))];
  const dates = [...new Set(entries.map((e) => e.work_date))];

  const [empRes, jobRes, assignRes] = await Promise.all([
    sb.from("commercial_employees").select("id, display_name").in("id", empIds),
    sb.from("commercial_jobs").select("id, name").in("id", jobIds),
    sb.from("commercial_assignments").select("employee_id, job_id, work_date, scheduled_hours").in("work_date", dates).neq("status", "cancelled"),
  ]);
  const empName = new Map((empRes.data ?? []).map((r) => [(r as { id: string }).id, (r as { display_name: string }).display_name]));
  const jobName = new Map((jobRes.data ?? []).map((r) => [(r as { id: string }).id, (r as { name: string }).name]));
  const schedKey = (e: string, j: string, d: string) => `${e}|${j}|${d}`;
  const sched = new Map<string, number>();
  for (const a of (assignRes.data ?? []) as { employee_id: string; job_id: string; work_date: string; scheduled_hours: number }[]) {
    sched.set(schedKey(a.employee_id, a.job_id, a.work_date), a.scheduled_hours);
  }

  return entries.map((e) => {
    const scheduled = sched.get(schedKey(e.employee_id, e.job_id, e.work_date)) ?? null;
    return {
      id: e.id,
      employee_id: e.employee_id,
      employee_name: empName.get(e.employee_id) ?? "(crew)",
      job_id: e.job_id,
      job_name: jobName.get(e.job_id) ?? "(job)",
      work_date: e.work_date,
      scheduled,
      actual: e.actual_hours,
      variance: scheduled == null ? null : Math.round((e.actual_hours - scheduled) * 100) / 100,
      status: e.status,
      source: e.source,
      questioned_reason: e.questioned_reason,
    };
  });
}

export async function approveTimeEntry(id: string, actorUserId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb.from("commercial_time_entries").select("*").eq("id", id).maybeSingle();
  if (!before) return { ok: false, error: "Entry not found." };
  const { data: after, error } = await sb
    .from("commercial_time_entries")
    .update({ status: "approved", approved_by_user_id: actorUserId, approved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  await logUpdate("commercial_time_entries", id, before, after, actorUserId);
  return { ok: true };
}

export async function questionTimeEntry(id: string, reason: string, actorUserId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb.from("commercial_time_entries").select("*").eq("id", id).maybeSingle();
  if (!before) return { ok: false, error: "Entry not found." };
  const { data: after, error } = await sb
    .from("commercial_time_entries")
    .update({ status: "questioned", questioned_reason: (reason ?? "").trim().slice(0, 300) || "Please review", updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  await logUpdate("commercial_time_entries", id, before, after, actorUserId);
  return { ok: true };
}

/** Manual override of the actual hours (Karan's manual-edit). Keeps it in
 *  'submitted' unless already approved; tags source 'manual'. */
export async function overrideTimeEntryHours(id: string, hours: number, actorUserId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!Number.isFinite(hours) || hours < 0 || hours > 24) return { ok: false, error: "Hours must be 0-24." };
  const sb = commercialDb();
  const { data: before } = await sb.from("commercial_time_entries").select("*").eq("id", id).maybeSingle();
  if (!before) return { ok: false, error: "Entry not found." };
  const { data: after, error } = await sb
    .from("commercial_time_entries")
    .update({ actual_hours: Math.round(hours * 4) / 4, source: "manual", status: "submitted", questioned_reason: null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  await logUpdate("commercial_time_entries", id, before, after, actorUserId);
  return { ok: true };
}

/** Approve every submitted entry whose actual == scheduled (no variance). */
export async function bulkApproveZeroVariance(actorUserId: string): Promise<{ approved: number }> {
  const rows = await listPendingApprovals();
  const zero = rows.filter((r) => r.status === "submitted" && r.variance === 0);
  let approved = 0;
  for (const r of zero) {
    const res = await approveTimeEntry(r.id, actorUserId);
    if (res.ok) approved++;
  }
  return { approved };
}
