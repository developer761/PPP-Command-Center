import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { addDaysIso } from "./schedule";
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
  capped: boolean; // a contributing punch was force-closed (capped guess) — never auto-approve
};

export async function listPendingApprovals(): Promise<ApprovalRow[]> {
  const sb = commercialDb();
  // Paginated — a busy pre-payroll backlog of pending entries can exceed
  // Supabase's silent 1000-row cap, which would drop the OLDEST entries so they
  // never render and can never be approved → underpaid crew (audit round 3).
  const entries = await paginateAll<{
    id: string; employee_id: string; job_id: string; work_date: string; actual_hours: number; status: string; source: string; questioned_reason: string | null;
  }>(() =>
    sb
      .from("commercial_time_entries")
      .select("id, employee_id, job_id, work_date, actual_hours, status, source, questioned_reason")
      .in("status", ["submitted", "questioned"])
      .order("work_date", { ascending: false })
      .order("id")
  );
  if (entries.length === 0) return [];

  const empIds = [...new Set(entries.map((e) => e.employee_id))];
  const jobIds = [...new Set(entries.map((e) => e.job_id))];
  const dates = [...new Set(entries.map((e) => e.work_date))];

  const [empRes, jobRes, assigns] = await Promise.all([
    sb.from("commercial_employees").select("id, display_name").in("id", empIds),
    sb.from("commercial_jobs").select("id, name").in("id", jobIds),
    // Scoped to these employees + paginated so the scheduled-hours baseline is
    // complete (a wide crew × many dates otherwise trips the 1000-row cap and
    // mislabels genuine zero-variance rows as "no schedule").
    paginateAll<{ employee_id: string; job_id: string; work_date: string; scheduled_hours: number }>(() =>
      sb
        .from("commercial_assignments")
        .select("employee_id, job_id, work_date, scheduled_hours")
        .in("work_date", dates)
        .in("employee_id", empIds)
        .neq("status", "cancelled")
        .order("work_date")
        .order("id")
    ),
  ]);
  const empName = new Map((empRes.data ?? []).map((r) => [(r as { id: string }).id, (r as { display_name: string }).display_name]));
  const jobName = new Map((jobRes.data ?? []).map((r) => [(r as { id: string }).id, (r as { name: string }).name]));
  const schedKey = (e: string, j: string, d: string) => `${e}|${j}|${d}`;
  const sched = new Map<string, number>();
  for (const a of assigns) {
    sched.set(schedKey(a.employee_id, a.job_id, a.work_date), a.scheduled_hours);
  }

  // Which entries are backed by a FORCE-CLOSED (capped-guess) punch? Those must
  // never be bulk-auto-approved even at zero variance — a forgotten clock-out
  // capped at the scheduled hours reads as variance 0 (audit round 7). Detected
  // from the persisted punch note marker.
  const capKeys = new Set<string>();
  if (dates.length > 0) {
    const sorted = [...dates].sort();
    // Paginated like the sibling queries above — a large window could otherwise
    // drop capped punches past the 1000-row cap, letting a capped guess slip into
    // zero-variance bulk-approve (audit round 10).
    const capRows = await paginateAll<{ employee_id: string; job_id: string; clock_in_at: string }>(() =>
      sb
        .from("commercial_time_punches")
        .select("employee_id, job_id, clock_in_at")
        .in("employee_id", empIds)
        .ilike("note", "%[auto-closed%")
        .gte("clock_in_at", `${addDaysIso(sorted[0], -1)}T00:00:00Z`)
        .lte("clock_in_at", `${addDaysIso(sorted[sorted.length - 1], 1)}T23:59:59Z`)
        .order("clock_in_at")
        .order("id")
    );
    const etDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    for (const p of capRows) {
      capKeys.add(schedKey(p.employee_id, p.job_id, etDay(p.clock_in_at)));
    }
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
      capped: capKeys.has(schedKey(e.employee_id, e.job_id, e.work_date)),
    };
  });
}

// An exported entry is PAID/settled — the same terminal state clock.ts respects.
// Changing it (approve/question/edit) from a stale Approvals tab would pull it out
// of, or re-add it to, the paid set → double-pay or clawback (audit round 12).
const EXPORTED_LOCKED = "This entry is already exported/paid and can't be changed.";
const EXPORTED_RACED = "This entry was just exported/paid — reload the queue.";

export async function approveTimeEntry(id: string, actorUserId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb.from("commercial_time_entries").select("*").eq("id", id).maybeSingle();
  if (!before) return { ok: false, error: "Entry not found." };
  if ((before as { status?: string }).status === "exported") return { ok: false, error: EXPORTED_LOCKED };
  const { data: after, error } = await sb
    .from("commercial_time_entries")
    .update({ status: "approved", approved_by_user_id: actorUserId, approved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id)
    .neq("status", "exported") // race guard: never undo a concurrent export
    .select("*")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!after) return { ok: false, error: EXPORTED_RACED };
  await logUpdate("commercial_time_entries", id, before, after, actorUserId);
  return { ok: true };
}

export async function questionTimeEntry(id: string, reason: string, actorUserId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb.from("commercial_time_entries").select("*").eq("id", id).maybeSingle();
  if (!before) return { ok: false, error: "Entry not found." };
  if ((before as { status?: string }).status === "exported") return { ok: false, error: EXPORTED_LOCKED };
  const { data: after, error } = await sb
    .from("commercial_time_entries")
    .update({ status: "questioned", questioned_reason: (reason ?? "").trim().slice(0, 300) || "Please review", updated_at: new Date().toISOString() })
    .eq("id", id)
    .neq("status", "exported")
    .select("*")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!after) return { ok: false, error: EXPORTED_RACED };
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
  if ((before as { status?: string }).status === "exported") return { ok: false, error: EXPORTED_LOCKED };
  const { data: after, error } = await sb
    .from("commercial_time_entries")
    .update({ actual_hours: Math.round(hours * 4) / 4, source: "manual", status: "submitted", questioned_reason: null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .neq("status", "exported")
    .select("*")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!after) return { ok: false, error: EXPORTED_RACED };
  await logUpdate("commercial_time_entries", id, before, after, actorUserId);
  return { ok: true };
}

/** Approve every submitted entry whose actual == scheduled (no variance). */
export async function bulkApproveZeroVariance(actorUserId: string): Promise<{ approved: number }> {
  const rows = await listPendingApprovals();
  // Exclude capped-guess entries — a force-closed missed-clock-out must be
  // approved by a human, one at a time, never in the zero-variance sweep.
  const zero = rows.filter((r) => r.status === "submitted" && r.variance === 0 && !r.capped);
  let approved = 0;
  for (const r of zero) {
    const res = await approveTimeEntry(r.id, actorUserId);
    if (res.ok) approved++;
  }
  return { approved };
}
