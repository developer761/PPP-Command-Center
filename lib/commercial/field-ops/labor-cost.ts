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
/** Exported so the Labor report counts the same entries the deal P&L does —
 *  one definition of "this hour is a settled cost", not two. */
export { SETTLED_STATUSES };

export type RateRow = { employee_id: string; cost_rate_cents: number; rate_type: string; effective_from: string; effective_to: string | null };

/** All rate rows for a set of employees, newest-effective first. One query. */
export async function loadRates(employeeIds: string[]): Promise<Map<string, RateRow[]>> {
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
export function rateOn(rows: RateRow[] | undefined, workDate: string): { cents: number; type: string } | null {
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
/**
 * "Is this work day inside a week payroll has already costed?"
 *
 * Extracted so the two readers of the time-entry table cannot drift.
 * `fieldOpsLaborByOpp` stood down for an allocated week and
 * `fieldOpsCrewDetailForOpp` did not, while claiming in its own docblock to
 * return the same figure — so the deal page would have priced hours from the
 * rate card that were already posted as a payout beside them.
 */
async function allocatedWeekPredicate(
  sb: ReturnType<typeof commercialDb>,
): Promise<(ymd: string) => boolean> {
  const { data, error } = await sb
    .from("commercial_payroll_periods")
    .select("start_date, end_date")
    .eq("status", "allocated")
    .is("deleted_at", null);
  // Read the error: supabase-js RESOLVES on failure. Treating a failed read as
  // "no allocated weeks" would silently re-enable the double count.
  if (error) {
    console.error("[labor-cost] could not read allocated payroll weeks:", error.message);
    // Fail CLOSED: stand down everywhere rather than risk charging twice.
    return () => true;
  }
  const weeks = ((data ?? []) as { start_date: string; end_date: string }[]).map(
    (w) => [w.start_date, w.end_date] as const,
  );
  return (ymd: string) => weeks.some(([from, to]) => ymd >= from && ymd <= to);
}

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
      .order("id")
  );
  if (entries.length === 0) return out;

  // W-2 ONLY — this "Crew labor" cost is the auto counterpart to the MANUAL
  // "Subcontract labor" purchase category (1099/subs). A sub/temp who clocks via
  // a magic link would otherwise be double-counted (here AND in that purchase
  // bucket) and diverge from payroll, which is also W-2-only (audit round 8).
  const { data: w2Rows } = await sb
    .from("commercial_employees")
    .select("id, worker_type")
    .in("id", [...new Set(entries.map((e) => e.employee_id))]);
  const w2 = new Set(((w2Rows ?? []) as { id: string; worker_type: string }[]).filter((r) => r.worker_type === "w2").map((r) => r.id));

  const rates = await loadRates(entries.map((e) => e.employee_id));

  /**
   * WEEKS ALREADY COSTED BY PAYROLL ARE NOT PRICED AGAIN.
   *
   * Job cost is `purchases + fieldOpsLabor` (projects/db.ts). Posting a
   * payroll week writes a `labor` PURCHASE per job from the real Gusto
   * liability — so if this also prices those same hours from the rate card,
   * the same person's week is charged twice, both halves real, and the only
   * symptom is a margin that quietly drops.
   *
   * The payout is the better figure: it is what left the bank, taxes included,
   * rather than a rate somebody has to remember to keep current. So an
   * allocated week wins and this stands down for it.
   *
   * Keyed on the WEEK, not the employee, because an employee can be costed by
   * payroll for one week and have no payroll at all for another.
   */
  const inAllocatedWeek = await allocatedWeekPredicate(sb);

  for (const e of entries) {
    if (!w2.has(e.employee_id)) continue;
    if (inAllocatedWeek(String(e.work_date).slice(0, 10))) continue;
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
  /** Paid through a labor company, so `costCents` is 0 and that is correct —
   *  what they cost is the Subcontract-labor payout on this same deal. */
  isSub?: boolean;
  /** Distinct days this worker had settled hours on the deal — the attendance
   *  count. Hours alone can't say whether 40 hours was one crew for a week or
   *  five people for a day. */
  days: number;
};

export type CrewDetailForOpp = {
  workers: CrewLaborWorker[];
  /** Every distinct work date with settled hours, ascending. */
  days: string[];
  /** Σ hours (rated + unrated) across the workers below. */
  totalHours: number;
  /** Σ burdened cost — the same figure `fieldOpsLaborForOpp` returns when no
   *  range is given. */
  costCents: number;
  unratedHours: number;
};

const EMPTY_DETAIL: CrewDetailForOpp = { workers: [], days: [], totalHours: 0, costCents: 0, unratedHours: 0 };

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Crew labor on ONE deal, broken out by worker AND by day.
 *
 * One walk of the job → time-entry path. The per-worker table and the
 * attendance-day count are cut from the same entries, so a report can never
 * show 12 days beside a set of workers that only add up to 9 — which is what
 * happens when two callers each run their own query.
 *
 * `range` narrows on `work_date` (inclusive, YYYY-MM-DD). Omit it for the whole
 * life of the job.
 */
export async function fieldOpsCrewDetailForOpp(
  oppId: string,
  range?: { fromYmd: string; toYmd: string } | null
): Promise<CrewDetailForOpp> {
  const sb = commercialDb();
  const inAllocatedWeek = await allocatedWeekPredicate(sb);
  // Include soft-deleted jobs — their settled hours were paid (audit 2026-08).
  const { data: jobRows } = await sb
    .from("commercial_jobs")
    .select("id")
    .eq("opportunity_id", oppId);
  const jobIds = ((jobRows ?? []) as { id: string }[]).map((j) => j.id);
  if (jobIds.length === 0) return { ...EMPTY_DETAIL, workers: [], days: [] };

  const entries = await paginateAll<{ employee_id: string; work_date: string; actual_hours: number }>(() => {
    let q = sb
      .from("commercial_time_entries")
      .select("employee_id, work_date, actual_hours, status")
      .in("job_id", jobIds)
      .in("status", SETTLED_STATUSES as unknown as string[]);
    if (range) q = q.gte("work_date", range.fromYmd).lte("work_date", range.toYmd);
    return q.order("work_date").order("id");
  });
  if (entries.length === 0) return { ...EMPTY_DETAIL, workers: [], days: [] };

  /**
   * W-2 decides who is PRICED, not who is counted.
   *
   * Karan 2026-09-17: "do labor costs go into costs for opportunities? if I put
   * labor on a certain day it should go into that opportunity under costs."
   *
   * This used to skip a sub's entries entirely, and every one of Tomco's 23
   * crew is `worker_type='sub'` — so the job's crew panel was empty on every
   * job, and a day of logged hours left no trace on the opportunity at all.
   * Same defect, same cause, as the Labor report (lib/commercial/reports/labor.ts).
   *
   * Their COST still must not be rate-priced here: a sub is paid through their
   * labor company, that payment is already booked as a Subcontract-labor
   * purchase on this same deal, and pricing their hours as well would count the
   * work twice on the one screen that shows both. So hours count for everyone,
   * `costCents` stays W-2-only, and the two sit side by side without being
   * added.
   */
  const { data: w2Rows } = await sb
    .from("commercial_employees")
    .select("id, worker_type")
    .in("id", [...new Set(entries.map((e) => e.employee_id))]);
  const w2 = new Set(((w2Rows ?? []) as { id: string; worker_type: string }[]).filter((r) => r.worker_type === "w2").map((r) => r.id));

  const rates = await loadRates(entries.map((e) => e.employee_id));
  const today = etTodayIso();
  const byEmp = new Map<string, CrewLaborWorker>();
  const daysByEmp = new Map<string, Set<string>>();
  const allDays = new Set<string>();
  for (const e of entries) {
    const hours = Number(e.actual_hours ?? 0);
    if (hours <= 0) continue;
    const isW2 = w2.has(e.employee_id);
    const workDate = String(e.work_date).slice(0, 10);
    /**
     * STAND DOWN for a week payroll has already costed — the same rule
     * `fieldOpsLaborByOpp` follows, and for the same reason.
     *
     * That function skips hours inside an `allocated` payroll period because
     * posting the week writes the real Gusto cost as an `employee_labor`
     * purchase on each job; pricing the same hours from the rate card as well
     * charges them twice, both halves looking real. This function reads the
     * same table with the same W-2 pricing and had no such guard, while its
     * own docblock promised `costCents` was "the same figure
     * fieldOpsLaborForOpp returns". The moment any week is posted that stops
     * being true, and the deal page's Crew labor panel prices hours that are
     * already sitting as a payout in the Costs section beside it.
     */
    if (isW2 && inAllocatedWeek(workDate)) continue;
    const rows = rates.get(e.employee_id);
    // A sub has no rate BY DESIGN — their money is the payout to their company.
    // Reading one for them would both double the cost and put all 23 crew under
    // "no cost rate on file", which is a list of 23 rates nobody should set.
    const rate = isW2 ? rateOn(rows, workDate) : null;
    const cur =
      byEmp.get(e.employee_id) ??
      ({ employeeId: e.employee_id, name: "", hours: 0, ratedHours: 0, unratedHours: 0, costCents: 0, currentRateCents: isW2 ? (rateOn(rows, today)?.cents ?? null) : null, isSub: !isW2, days: 0 } as CrewLaborWorker);
    cur.hours += hours;
    if (rate) {
      cur.costCents += Math.round(hours * rate.cents);
      cur.ratedHours += hours;
    } else if (isW2) {
      cur.unratedHours += hours;
    }
    byEmp.set(e.employee_id, cur);
    const ds = daysByEmp.get(e.employee_id) ?? new Set<string>();
    ds.add(workDate);
    daysByEmp.set(e.employee_id, ds);
    allDays.add(workDate);
  }
  if (byEmp.size === 0) return { ...EMPTY_DETAIL, workers: [], days: [] };

  // Resolve names.
  const { data: empRows } = await sb
    .from("commercial_employees")
    .select("id, display_name")
    .in("id", [...byEmp.keys()]);
  const nameById = new Map<string, string>();
  for (const r of (empRows ?? []) as { id: string; display_name: string | null }[]) {
    nameById.set(r.id, (r.display_name ?? "").trim() || "Crew member");
  }
  const workers = [...byEmp.values()].map((w) => ({
    ...w,
    name: nameById.get(w.employeeId) ?? "Crew member",
    hours: round2(w.hours),
    ratedHours: round2(w.ratedHours),
    unratedHours: round2(w.unratedHours),
    days: daysByEmp.get(w.employeeId)?.size ?? 0,
  }));
  // Hours break the tie, and for a sub they decide it: their cost here is 0 by
  // design, so sorting on cost alone left the whole crew in arbitrary order.
  workers.sort((a, b) => b.costCents - a.costCents || b.hours - a.hours || a.name.localeCompare(b.name));

  return {
    workers,
    days: [...allDays].sort(),
    totalHours: round2(workers.reduce((n, w) => n + w.hours, 0)),
    costCents: workers.reduce((n, w) => n + w.costCents, 0),
    unratedHours: round2(workers.reduce((n, w) => n + w.unratedHours, 0)),
  };
}

/**
 * Per-worker crew-labor breakdown for ONE deal — the in-house (time-entry)
 * counterpart to laborByWorkerForProject (which covers manual subcontract-labor
 * purchases). Costliest worker first; a worker with unrated hours is surfaced so
 * the operator knows whose rate to set. Names come from commercial_employees.
 */
export async function fieldOpsLaborByWorkerForOpp(oppId: string): Promise<CrewLaborWorker[]> {
  return (await fieldOpsCrewDetailForOpp(oppId)).workers;
}
