import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { logInsert, logUpdate } from "@/lib/commercial/audit-log";
import {
  allocatePayrollToJobs,
  allocationSumsTo,
  type JobAllocation,
} from "./payroll-allocation";

/**
 * One payroll week, from hours through to job cost.
 *
 * The four panels on Tomco's mockup, in order: hours per employee, the actual
 * Gusto cost typed against each, the automatic split across jobs, and the
 * per-job detail. They are computed from ONE read here rather than four, which
 * is not an optimisation — it is the only way they can agree.
 *
 * The mockup's own numbers do not tie: its hours panel totals 192 and its
 * allocation panel 254, and its Gusto costs sum to $5,875 against an allocated
 * $6,777. Illustrative, and harmless on a slide. On the real screen that would
 * be Mary reconciling two halves of one page, which is the job we are removing.
 * So the invariant is enforced here, asserted, and reported when it fails.
 */

export type EmployeeWeek = {
  employeeId: string;
  name: string;
  /** Hours that landed on a job. This is the allocation denominator. */
  jobHours: number;
  /** Hours with no job behind them — PTO, shop time, an unassigned entry. */
  unassignedHours: number;
  /** What Gusto actually cost, once Mary has entered it. */
  actualCostCents: number | null;
  grossCents: number | null;
  /** Per job, for the split. */
  jobs: { opportunityId: string; jobName: string; hours: number }[];
  /** The split, once there is a cost to split. */
  allocation: JobAllocation[];
  /** Actual cost ÷ job hours — the "Loaded Hrly Cost" column. */
  loadedHourlyCents: number | null;
};

export type PayrollWeek = {
  periodId: string | null;
  startDate: string;
  endDate: string;
  status: "draft" | "allocated";
  employees: EmployeeWeek[];
  totals: {
    jobHours: number;
    unassignedHours: number;
    actualCostCents: number;
    allocatedCents: number;
  };
  /** Per job, across everybody — the "Automatic Job Cost Allocation" panel. */
  byJob: { opportunityId: string; jobName: string; hours: number; costCents: number }[];
  /**
   * Why this week cannot be posted yet, in the order Mary would fix them.
   * Empty means it can.
   */
  blockers: string[];
  /** Hours that are logged but not yet approved — they are NOT costed. */
  unapprovedHours: number;
};

/** Settled time only. A submitted or questioned entry is not yet a cost —
 *  the same constant the deal P&L and the labor report use. */
const SETTLED = ["approved", "exported"];

export async function getPayrollWeek(
  startDate: string,
  endDate: string,
): Promise<PayrollWeek> {
  const sb = commercialDb();

  const [{ data: periodRow }, entries, { data: empRows }, { data: jobRows }] =
    await Promise.all([
      sb
        .from("commercial_payroll_periods")
        .select("id, status")
        .eq("start_date", startDate)
        .is("deleted_at", null)
        .maybeSingle(),
      paginateAll<{
        employee_id: string;
        job_id: string | null;
        actual_hours: number;
        status: string;
      }>(() =>
        sb
          .from("commercial_time_entries")
          .select("employee_id, job_id, actual_hours, status")
          .gte("work_date", startDate)
          .lte("work_date", endDate)
          .order("id", { ascending: true }),
      ),
      sb.from("commercial_employees").select("id, display_name, worker_type, active"),
      sb.from("commercial_jobs").select("id, name, opportunity_id").is("deleted_at", null),
    ]);

  const period = periodRow as { id: string; status: string } | null;
  const empName = new Map(
    ((empRows ?? []) as { id: string; display_name: string }[]).map((e) => [
      e.id,
      e.display_name,
    ]),
  );
  const jobs = (jobRows ?? []) as { id: string; name: string; opportunity_id: string | null }[];
  const jobOpp = new Map(jobs.map((j) => [j.id, j.opportunity_id]));
  const jobName = new Map(jobs.map((j) => [j.id, j.name]));

  const costs = period
    ? ((
        await sb
          .from("commercial_payroll_costs")
          .select("employee_id, actual_cost_cents, gross_cents")
          .eq("period_id", period.id)
      ).data ?? [])
    : [];
  const costByEmp = new Map(
    (costs as { employee_id: string; actual_cost_cents: number; gross_cents: number | null }[]).map(
      (c) => [c.employee_id, c],
    ),
  );

  // Build each person's week. Hours with no job behind them are counted
  // SEPARATELY and kept out of the denominator: spreading a day of PTO across
  // the jobs somebody did not work that day makes every one of them read
  // dearer than it was.
  const byEmp = new Map<string, EmployeeWeek>();
  let unapprovedHours = 0;
  for (const t of entries) {
    const hours = Number(t.actual_hours ?? 0);
    if (hours <= 0) continue;
    if (!SETTLED.includes(t.status)) {
      unapprovedHours += hours;
      continue;
    }
    const row =
      byEmp.get(t.employee_id) ??
      ({
        employeeId: t.employee_id,
        name: empName.get(t.employee_id) ?? "(unknown)",
        jobHours: 0,
        unassignedHours: 0,
        actualCostCents: null,
        grossCents: null,
        jobs: [],
        allocation: [],
        loadedHourlyCents: null,
      } as EmployeeWeek);
    const opp = t.job_id ? jobOpp.get(t.job_id) ?? null : null;
    if (!opp) {
      row.unassignedHours += hours;
    } else {
      row.jobHours += hours;
      const existing = row.jobs.find((j) => j.opportunityId === opp);
      if (existing) existing.hours += hours;
      else
        row.jobs.push({
          opportunityId: opp,
          jobName: (t.job_id && jobName.get(t.job_id)) || "Job",
          hours,
        });
    }
    byEmp.set(t.employee_id, row);
  }

  const employees = [...byEmp.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const e of employees) {
    const c = costByEmp.get(e.employeeId);
    e.actualCostCents = c ? Number(c.actual_cost_cents) : null;
    e.grossCents = c?.gross_cents == null ? null : Number(c.gross_cents);
    e.jobs.sort((a, b) => b.hours - a.hours);
    if (e.actualCostCents != null && e.jobHours > 0) {
      e.allocation = allocatePayrollToJobs(e.actualCostCents, e.jobs);
      e.loadedHourlyCents = Math.round(e.actualCostCents / e.jobHours);
    }
  }

  // Roll the splits up per job — the same numbers, grouped the other way, so
  // the two panels cannot disagree.
  const jobTotals = new Map<string, { opportunityId: string; jobName: string; hours: number; costCents: number }>();
  for (const e of employees) {
    for (const j of e.jobs) {
      const cur =
        jobTotals.get(j.opportunityId) ??
        { opportunityId: j.opportunityId, jobName: j.jobName, hours: 0, costCents: 0 };
      cur.hours += j.hours;
      jobTotals.set(j.opportunityId, cur);
    }
    for (const a of e.allocation) {
      const cur = jobTotals.get(a.opportunityId);
      if (cur) cur.costCents += a.amountCents;
    }
  }

  const totals = {
    jobHours: employees.reduce((n, e) => n + e.jobHours, 0),
    unassignedHours: employees.reduce((n, e) => n + e.unassignedHours, 0),
    actualCostCents: employees.reduce((n, e) => n + (e.actualCostCents ?? 0), 0),
    allocatedCents: employees.reduce(
      (n, e) => n + e.allocation.reduce((m, a) => m + a.amountCents, 0),
      0,
    ),
  };

  // What still has to happen before this can be posted, in Mary's order.
  const blockers: string[] = [];
  if (employees.length === 0) blockers.push("No approved hours in this week yet.");
  if (unapprovedHours > 0)
    blockers.push(
      `${unapprovedHours}h are logged but not approved, so they are not costed. Approve them first or they land on no job.`,
    );
  const noCost = employees.filter((e) => e.actualCostCents == null && e.jobHours > 0);
  if (noCost.length > 0)
    blockers.push(
      `No Gusto cost entered for ${noCost.map((e) => e.name).join(", ")}.`,
    );
  const noHours = employees.filter((e) => (e.actualCostCents ?? 0) > 0 && e.jobHours === 0);
  if (noHours.length > 0)
    blockers.push(
      `${noHours.map((e) => e.name).join(", ")} ${noHours.length === 1 ? "has" : "have"} a Gusto cost but no job hours — that money has nowhere to go.`,
    );
  // The invariant the mockup breaks. Cheap to check, and the one number Mary
  // would otherwise reconcile by hand.
  for (const e of employees) {
    if (e.actualCostCents != null && e.jobHours > 0 && !allocationSumsTo(e.allocation, e.actualCostCents))
      blockers.push(`${e.name}'s split does not add up to their Gusto cost — do not post this week.`);
  }

  return {
    periodId: period?.id ?? null,
    startDate,
    endDate,
    status: (period?.status as "draft" | "allocated") ?? "draft",
    employees,
    totals,
    byJob: [...jobTotals.values()].sort((a, b) => b.hours - a.hours),
    blockers,
    unapprovedHours,
  };
}

/** Create the week if it does not exist yet, so costs have something to hang on. */
export async function ensurePayrollPeriod(
  startDate: string,
  endDate: string,
  userId: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: existing } = await sb
    .from("commercial_payroll_periods")
    .select("id")
    .eq("start_date", startDate)
    .is("deleted_at", null)
    .maybeSingle();
  if (existing) return { ok: true, id: (existing as { id: string }).id };

  const { data, error } = await sb
    .from("commercial_payroll_periods")
    .insert({ start_date: startDate, end_date: endDate, created_by_user_id: userId })
    .select("*")
    .maybeSingle();
  if (error || !data) return { ok: false, error: error?.message ?? "insert_failed" };
  await logInsert("commercial_payroll_periods", (data as { id: string }).id, data, userId);
  return { ok: true, id: (data as { id: string }).id };
}

/** Record what Gusto actually cost for one person in one week. */
export async function setPayrollCost(input: {
  periodId: string;
  employeeId: string;
  actualCostCents: number;
  grossCents?: number | null;
  userId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!Number.isFinite(input.actualCostCents) || input.actualCostCents < 0)
    return { ok: false, error: "Enter the actual cost from Gusto." };
  const sb = commercialDb();
  const { error } = await sb.from("commercial_payroll_costs").upsert(
    {
      period_id: input.periodId,
      employee_id: input.employeeId,
      actual_cost_cents: Math.round(input.actualCostCents),
      gross_cents: input.grossCents == null ? null : Math.round(input.grossCents),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "period_id,employee_id" },
  );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Post the week: turn each split into the labor payouts the platform already
 * costs jobs from.
 *
 * RE-RUNNABLE ON PURPOSE. Mary will correct a Gusto figure — a cheque that
 * bounced, a person she missed — and re-post. Without the `payroll_period_id`
 * link, a second run would lay a second set of payouts on top of the first and
 * double every job for that week, with both halves looking entirely real. So
 * this replaces its own previous rows rather than adding to them, and touches
 * nothing it did not create: a payout Mary typed by hand has no period id and
 * is never removed by this.
 *
 * Refuses on any blocker. Posting a week with unapproved hours or a missing
 * Gusto cost puts money on the wrong jobs, and the fix afterwards is worse
 * than the wait.
 */
export async function postPayrollWeek(
  startDate: string,
  endDate: string,
  userId: string,
): Promise<
  | { ok: true; created: number; replaced: number; totalCents: number }
  | { ok: false; error: string }
> {
  const week = await getPayrollWeek(startDate, endDate);
  if (week.blockers.length > 0) return { ok: false, error: week.blockers[0] };
  if (!week.periodId) return { ok: false, error: "This week has not been started yet." };

  const sb = commercialDb();

  // Everything this week posted last time. Removed, not updated: the set of
  // jobs can change between runs, so a row-by-row patch would leave orphans
  // from the previous shape.
  const { data: prior } = await sb
    .from("commercial_project_purchases")
    .select("id")
    .eq("payroll_period_id", week.periodId)
    .is("deleted_at", null);
  const replaced = ((prior ?? []) as { id: string }[]).length;
  if (replaced > 0) {
    const { error: delErr } = await sb
      .from("commercial_project_purchases")
      .update({ deleted_at: new Date().toISOString() })
      .eq("payroll_period_id", week.periodId)
      .is("deleted_at", null);
    if (delErr)
      return {
        ok: false,
        error: `Could not clear the previous run for this week, so nothing was posted: ${delErr.message}`,
      };
  }

  // The account each job belongs to — a payout is filed against both.
  const oppIds = [...new Set(week.byJob.map((j) => j.opportunityId))];
  const { data: oppRows } = await sb
    .from("commercial_opportunities")
    .select("id, account_id")
    .in("id", oppIds);
  const accountOf = new Map(
    ((oppRows ?? []) as { id: string; account_id: string }[]).map((o) => [o.id, o.account_id]),
  );

  const rows: Record<string, unknown>[] = [];
  for (const e of week.employees) {
    for (const a of e.allocation) {
      const accountId = accountOf.get(a.opportunityId);
      if (!accountId) continue;
      rows.push({
        opportunity_id: a.opportunityId,
        account_id: accountId,
        category: "labor",
        vendor: e.name,
        amount_cents: a.amountCents,
        hours: a.hours,
        // Dated to the END of the week it pays for, not the day it was posted,
        // so a job's costs sit in the period the work happened.
        purchased_at: `${endDate}T16:00:00.000Z`,
        description: `Payroll ${startDate} – ${endDate} · ${a.hours}h of ${e.jobHours}h`,
        payroll_period_id: week.periodId,
        created_by_user_id: userId,
      });
    }
  }
  if (rows.length === 0) return { ok: false, error: "Nothing to post for this week." };

  const { error: insErr } = await sb.from("commercial_project_purchases").insert(rows);
  if (insErr) return { ok: false, error: insErr.message };

  const { data: before } = await sb
    .from("commercial_payroll_periods")
    .select("*")
    .eq("id", week.periodId)
    .maybeSingle();
  const { data: after } = await sb
    .from("commercial_payroll_periods")
    .update({
      status: "allocated",
      allocated_at: new Date().toISOString(),
      allocated_by_user_id: userId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", week.periodId)
    .select("*")
    .maybeSingle();
  if (before && after)
    await logUpdate("commercial_payroll_periods", week.periodId, before, after, userId);

  return {
    ok: true,
    created: rows.length,
    replaced,
    totalCents: rows.reduce((n, r) => n + Number(r.amount_cents), 0),
  };
}
