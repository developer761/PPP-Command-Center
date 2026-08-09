import "server-only";

/**
 * Option A — Field-Ops labor → deal P&L.
 *
 * The COST of a deal's labor, computed from what the crew ACTUALLY worked:
 * Σ over approved time-entries of (hours × the worker's burdened cost rate
 * effective on that work day). This is the auto counterpart to the manual
 * "Subcontract labor" purchase category (1099/subs), so a deal's real gross
 * margin reflects in-house crew cost without anyone re-typing it.
 *
 * Link path: commercial_time_entries.employee_id + .job_id → commercial_jobs
 * (job_code / work order) → .opportunity_id (the deal). Only SETTLED entries
 * count — approved OR already exported to payroll (see SETTLED_STATUSES); a
 * submitted/questioned entry isn't a settled cost yet. Only jobs tied to a deal
 * (opportunity_id not null) roll in — a standalone PPP / one-off WO has no deal
 * P&L to roll into.
 *
 * Cost rate is EFFECTIVE-DATED (commercial_employee_rates): a raise last month
 * doesn't restate a job worked before it. A worker with no rate on file costs $0
 * and is surfaced as a data-quality nudge, never silently dropped.
 */

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { etTodayIso } from "@/lib/date-et";

// A settled labor cost = an APPROVED entry, INCLUDING those already exported to
// payroll ('exported' is approved-then-sent, still a real cost). Matching
// overview.ts, which counts both as approved hours — otherwise a deal's labor
// cost would vanish the moment payroll runs its export.
const SETTLED_STATUSES = ["approved", "exported"] as const;

type RateRow = { employee_id: string; cost_rate_cents: number; rate_type: string; effective_from: string; effective_to: string | null };

/** All rate rows for a set of employees, newest-effective first. One query. */
async function loadRates(employeeIds: string[]): Promise<Map<string, RateRow[]>> {
  const out = new Map<string, RateRow[]>();
  const ids = [...new Set(employeeIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_employee_rates")
    .select("employee_id, cost_rate_cents, rate_type, effective_from, effective_to")
    .in("employee_id", ids)
    .order("effective_from", { ascending: false });
  for (const r of (data ?? []) as RateRow[]) {
    const arr = out.get(r.employee_id) ?? [];
    arr.push(r);
    out.set(r.employee_id, arr);
  }
  return out;
}

/** The cost rate ($/hr, in cents) effective for `employeeId` on `workDate`
 *  (YYYY-MM-DD), or null when no rate covers that day. Daily-type rates are
 *  normalized to an hourly figure by the caller's hours, so we return the raw
 *  cents + type. */
function rateOn(rows: RateRow[] | undefined, workDate: string): { cents: number; type: string } | null {
  if (!rows || rows.length === 0) return null;
  // rows are newest-first; pick the first whose window covers workDate.
  for (const r of rows) {
    if (r.effective_from <= workDate && (r.effective_to == null || r.effective_to >= workDate)) {
      return { cents: r.cost_rate_cents, type: r.rate_type };
    }
  }
  return null;
}

export type OppLaborCost = {
  /** Total burdened labor cost across approved entries tied to the deal. */
  cents: number;
  /** Approved hours that DID have a cost rate (priced). */
  ratedHours: number;
  /** Approved hours from workers with NO cost rate on the work day (unpriced →
   *  $0). > 0 means the margin understates labor cost until a rate is set. */
  unratedHours: number;
};

const EMPTY: OppLaborCost = { cents: 0, ratedHours: 0, unratedHours: 0 };

/**
 * Field-Ops labor cost for MANY deals at once — keyed by opportunity_id. One
 * pass, no N+1. Opps with no linked/approved labor simply don't appear in the
 * map (callers treat a miss as $0).
 */
export async function fieldOpsLaborByOpp(oppIds: string[]): Promise<Map<string, OppLaborCost>> {
  const out = new Map<string, OppLaborCost>();
  const ids = [...new Set(oppIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const sb = commercialDb();

  // Deal jobs (work orders) → their ids, mapped back to the opp. Include
  // soft-deleted jobs: their SETTLED (approved/exported) hours were still PAID,
  // so they must stay in the deal P&L — otherwise deleting a job silently zeroes
  // real crew cost while Payroll + Hours Log still count it (audit 2026-08).
  const { data: jobRows } = await sb
    .from("commercial_jobs")
    .select("id, opportunity_id")
    .in("opportunity_id", ids);
  const jobs = (jobRows ?? []) as { id: string; opportunity_id: string | null }[];
  if (jobs.length === 0) return out;
  const oppByJob = new Map<string, string>();
  for (const j of jobs) if (j.opportunity_id) oppByJob.set(j.id, j.opportunity_id);

  // Approved/exported time entries on those jobs. Paginated — a long-running
  // deal can exceed Supabase's silent 1000-row cap.
  const entries = await paginateAll<{ employee_id: string; job_id: string; work_date: string; actual_hours: number; status: string }>(() =>
    sb
      .from("commercial_time_entries")
      .select("employee_id, job_id, work_date, actual_hours, status")
      .in("job_id", [...oppByJob.keys()])
      .in("status", SETTLED_STATUSES as unknown as string[])
      .order("work_date")
  );
  if (entries.length === 0) return out;

  const rates = await loadRates(entries.map((e) => e.employee_id));

  for (const e of entries) {
    const oppId = oppByJob.get(e.job_id);
    if (!oppId) continue;
    const hours = Number(e.actual_hours ?? 0);
    if (hours <= 0) continue;
    const workDate = String(e.work_date).slice(0, 10);
    const rate = rateOn(rates.get(e.employee_id), workDate);
    const cur = out.get(oppId) ?? { ...EMPTY };
    if (rate) {
      // Daily-type rate → a full day = default hours is out of scope here; treat
      // the stored rate as $/hr (the Crew UI collects an hourly cost rate).
      cur.cents += Math.round(hours * rate.cents);
      cur.ratedHours += hours;
    } else {
      cur.unratedHours += hours;
    }
    out.set(oppId, cur);
  }
  return out;
}

/** Field-Ops labor cost for ONE deal. */
export async function fieldOpsLaborForOpp(oppId: string): Promise<OppLaborCost> {
  const m = await fieldOpsLaborByOpp([oppId]);
  return m.get(oppId) ?? { ...EMPTY };
}

export type CrewLaborWorker = {
  employeeId: string;
  name: string;
  /** Total approved hours on this deal (rated + unrated). */
  hours: number;
  /** Approved hours that had a cost rate on the work day. */
  ratedHours: number;
  /** Approved hours with no cost rate → they cost $0 here. */
  unratedHours: number;
  /** Σ burdened cost across this worker's approved hours on the deal. */
  costCents: number;
  /** The worker's CURRENT effective cost rate (for display), null if none. */
  currentRateCents: number | null;
};

/**
 * Per-worker crew-labor breakdown for ONE deal — the in-house (time-entry)
 * counterpart to laborByWorkerForProject (which covers manual subcontract-labor
 * purchases). Costliest worker first; a worker with unrated hours is surfaced so
 * the operator knows whose rate to set. Names come from commercial_employees.
 */
export async function fieldOpsLaborByWorkerForOpp(oppId: string): Promise<CrewLaborWorker[]> {
  const sb = commercialDb();
  // Include soft-deleted jobs — their settled hours were paid (audit 2026-08).
  const { data: jobRows } = await sb
    .from("commercial_jobs")
    .select("id")
    .eq("opportunity_id", oppId);
  const jobIds = ((jobRows ?? []) as { id: string }[]).map((j) => j.id);
  if (jobIds.length === 0) return [];

  const entries = await paginateAll<{ employee_id: string; work_date: string; actual_hours: number }>(() =>
    sb
      .from("commercial_time_entries")
      .select("employee_id, work_date, actual_hours, status")
      .in("job_id", jobIds)
      .in("status", SETTLED_STATUSES as unknown as string[])
      .order("work_date")
  );
  if (entries.length === 0) return [];

  const rates = await loadRates(entries.map((e) => e.employee_id));
  const today = etTodayIso();
  const byEmp = new Map<string, CrewLaborWorker>();
  for (const e of entries) {
    const hours = Number(e.actual_hours ?? 0);
    if (hours <= 0) continue;
    const workDate = String(e.work_date).slice(0, 10);
    const rows = rates.get(e.employee_id);
    const rate = rateOn(rows, workDate);
    const cur =
      byEmp.get(e.employee_id) ??
      ({ employeeId: e.employee_id, name: "", hours: 0, ratedHours: 0, unratedHours: 0, costCents: 0, currentRateCents: rateOn(rows, today)?.cents ?? null } as CrewLaborWorker);
    cur.hours += hours;
    if (rate) {
      cur.costCents += Math.round(hours * rate.cents);
      cur.ratedHours += hours;
    } else {
      cur.unratedHours += hours;
    }
    byEmp.set(e.employee_id, cur);
  }
  if (byEmp.size === 0) return [];

  // Resolve names.
  const { data: empRows } = await sb
    .from("commercial_employees")
    .select("id, display_name")
    .in("id", [...byEmp.keys()]);
  const nameById = new Map<string, string>();
  for (const r of (empRows ?? []) as { id: string; display_name: string | null }[]) {
    nameById.set(r.id, (r.display_name ?? "").trim() || "Crew member");
  }
  const out = [...byEmp.values()].map((w) => ({ ...w, name: nameById.get(w.employeeId) ?? "Crew member" }));
  out.sort((a, b) => b.costCents - a.costCents || b.hours - a.hours);
  return out;
}
