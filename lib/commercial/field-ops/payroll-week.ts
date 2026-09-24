import "server-only";

import { randomUUID } from "node:crypto";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";
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
  /**
   * The job those hours are charged to this week.
   *
   * Mary 2026-09-24: "Included. Like if Greg takes a vacation BD had me put it
   * against a job... he picks a job that can handle the expense." So this is a
   * person's decision, held per week, and null until it is made.
   */
  unassignedOpportunityId: string | null;
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
  /**
   * What is ACTUALLY on the jobs from the last post, read back from the
   * payouts — not recomputed from today's hours and costs.
   *
   * The two drift the moment anything changes after a post: a late time entry
   * approved, a Gusto figure corrected and saved but not re-posted. The banner
   * used to print the live total and say it was on the jobs, which was simply
   * untrue. Null when nothing has been posted.
   */
  postedCents: number | null;
};

/** Settled time only. A submitted or questioned entry is not yet a cost —
 *  the same constant the deal P&L and the labor report use. */
const SETTLED = ["approved", "exported"];

export async function getPayrollWeek(
  startDate: string,
  endDate: string,
): Promise<PayrollWeek> {
  const sb = commercialDb();

  const [{ data: periodRow }, entries, { data: empRows }, jobRows] =
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
      // PAGINATED, and NOT filtered on deleted_at.
      //
      // The cap first: PostgREST silently returns 1000 rows. Past that, the
      // missing jobs drop out of the lookup, their hours become "unassigned",
      // the denominator shrinks and money quietly redistributes onto the jobs
      // that made the cut. The reconcile's own history records this exact bug
      // reporting materials at 61% of the true figure.
      //
      // And the filter: a SETTLED hour on a job somebody later deleted was
      // still worked and still paid. Dropping it here would move that money
      // onto the other jobs. labor-cost.ts includes deleted jobs for the same
      // reason, in a comment written after an audit found it.
      paginateAll<{ id: string; name: string; opportunity_id: string | null }>(() =>
        sb
          .from("commercial_jobs")
          .select("id, name, opportunity_id")
          .order("id", { ascending: true }),
      ),
    ]);

  const period = periodRow as { id: string; status: string } | null;
  const allEmps = (empRows ?? []) as {
    id: string;
    display_name: string;
    worker_type: string | null;
    active: boolean;
  }[];
  const empName = new Map(allEmps.map((e) => [e.id, e.display_name]));
  /**
   * W-2 ONLY, AND THIS IS THE DOUBLE-COUNT GUARD.
   *
   * Gusto runs payroll for employees. A subcontractor is already costed by the
   * payout to their labour company — that is the whole sub model. Allocating a
   * payroll figure to one as well would put the same work on a job twice, and
   * both halves would look entirely real.
   *
   * With nobody flagged W-2 yet this list is empty, which is correct and is
   * said plainly rather than silently showing a blank week: the crew are all
   * `worker_type = 'sub'` until somebody switches them.
   */
  const isW2 = new Set(allEmps.filter((e) => e.worker_type === "w2").map((e) => e.id));
  const anyW2 = isW2.size > 0;
  const jobs = jobRows;
  const jobOpp = new Map(jobs.map((j) => [j.id, j.opportunity_id]));
  const jobName = new Map(jobs.map((j) => [j.id, j.name]));
  /** Opportunity id → a job name, for the job PTO is charged to. */
  const jobNameByOpp = new Map(
    jobs.filter((j) => j.opportunity_id).map((j) => [j.opportunity_id as string, j.name]),
  );

  const costs = period
    ? ((
        await sb
          .from("commercial_payroll_costs")
          .select("employee_id, actual_cost_cents, gross_cents, unassigned_opportunity_id")
          .eq("period_id", period.id)
      ).data ?? [])
    : [];
  const costByEmp = new Map(
    (
      costs as {
        employee_id: string;
        actual_cost_cents: number | null;
        gross_cents: number | null;
        unassigned_opportunity_id: string | null;
      }[]
    ).map((c) => [c.employee_id, c]),
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
    if (!isW2.has(t.employee_id)) continue; // a sub is costed by their payout
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
        unassignedOpportunityId: null,
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
    // NULL means not entered yet. 0 means genuinely nothing, which is a real
    // answer and must not be confused with the absence of one.
    e.actualCostCents = c && c.actual_cost_cents != null ? Number(c.actual_cost_cents) : null;
    e.grossCents = c?.gross_cents == null ? null : Number(c.gross_cents);
    e.unassignedOpportunityId = c?.unassigned_opportunity_id ?? null;
    e.jobs.sort((a, b) => b.hours - a.hours);

    /**
     * NON-JOB HOURS GO ON ONE JOB, NOT ACROSS ALL OF THEM.
     *
     * Folded into that job's hours before the split, so the money follows the
     * hours exactly as it does for worked time — and the job's hours column
     * shows what it is actually carrying.
     *
     * Until the job is chosen those hours are left out, and the week is
     * BLOCKED below rather than posting a split that quietly spread them.
     */
    const jobsForSplit = e.jobs.map((j) => ({ ...j }));
    if (e.unassignedHours > 0 && e.unassignedOpportunityId) {
      const target = jobsForSplit.find((j) => j.opportunityId === e.unassignedOpportunityId);
      if (target) target.hours += e.unassignedHours;
      else
        jobsForSplit.push({
          opportunityId: e.unassignedOpportunityId,
          jobName: jobNameByOpp.get(e.unassignedOpportunityId) ?? "Job",
          hours: e.unassignedHours,
        });
    }
    e.jobs = jobsForSplit.sort((a, b) => b.hours - a.hours);
    e.jobHours = jobsForSplit.reduce((n, j) => n + j.hours, 0);

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
  if (!anyW2)
    blockers.push(
      "Nobody is set up as a W-2 employee yet, so there is no payroll to split. Everyone on the crew is still a subcontractor, costed by their payout.",
    );
  else if (employees.length === 0)
    blockers.push("No approved hours for any W-2 employee in this week yet.");
  if (unapprovedHours > 0)
    blockers.push(
      `${unapprovedHours}h are logged but not approved, so they are not costed. Approve them first or they land on no job.`,
    );
  // Non-job hours with nowhere to go. Named per person, because Mary chooses
  // per person — and left unsaid, that money would silently spread.
  const needJob = employees.filter((e) => e.unassignedHours > 0 && !e.unassignedOpportunityId);
  if (needJob.length > 0)
    blockers.push(
      `Pick the job to charge non-job hours to for ${needJob.map((e) => `${e.name} (${e.unassignedHours}h)`).join(", ")}.`,
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

  const postedCents = period
    ? (
        (
          await sb
            .from("commercial_project_purchases")
            .select("amount_cents")
            .eq("payroll_period_id", period.id)
            .is("deleted_at", null)
        ).data ?? []
      ).reduce((n, r) => n + Number((r as { amount_cents: number }).amount_cents ?? 0), 0)
    : 0;

  return {
    periodId: period?.id ?? null,
    postedCents: period && postedCents > 0 ? postedCents : null,
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
  actualCostCents: number | null;
  grossCents?: number | null;
  /** The job this person's non-job hours are charged to. `undefined` leaves
   *  whatever is stored; `null` clears it. */
  unassignedOpportunityId?: string | null;
  userId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  // `null` is legitimate — the row may exist only to hold the PTO job choice.
  if (
    input.actualCostCents != null &&
    (!Number.isFinite(input.actualCostCents) || input.actualCostCents < 0)
  )
    return { ok: false, error: "Enter the actual cost from Gusto." };
  const sb = commercialDb();
  const { error } = await sb.from("commercial_payroll_costs").upsert(
    {
      period_id: input.periodId,
      employee_id: input.employeeId,
      actual_cost_cents:
        input.actualCostCents == null ? null : Math.round(input.actualCostCents),
      gross_cents: input.grossCents == null ? null : Math.round(input.grossCents),
      ...(input.unassignedOpportunityId !== undefined
        ? { unassigned_opportunity_id: input.unassignedOpportunityId }
        : {}),
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
    .select("*")
    .eq("payroll_period_id", week.periodId)
    .is("deleted_at", null);
  const priorRows = (prior ?? []) as Record<string, unknown>[];
  const replaced = priorRows.length;
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
    // LOGGED. This is the operation that removes the most money at once, and
    // it was the only one on the page invisible to the audit log — so if a
    // week posted wrong there was no record of what the previous run held.
    for (const r of priorRows)
      await logDelete("commercial_project_purchases", String(r.id), r, userId);
  }

  // The account each job belongs to — a payout is filed against both.
  const oppIds = [...new Set(week.byJob.map((j) => j.opportunityId))];
  // Live deals only. Every other purchase writer refuses a deleted one
  // ("This deal has been deleted — purchases can't be modified"), and money
  // landing on a deal nobody can open is money nobody will find.
  const { data: oppRows } = await sb
    .from("commercial_opportunities")
    .select("id, account_id")
    .in("id", oppIds)
    .is("deleted_at", null);
  const accountOf = new Map(
    ((oppRows ?? []) as { id: string; account_id: string }[]).map((o) => [o.id, o.account_id]),
  );

  const rows: Record<string, unknown>[] = [];
  const skipped: string[] = [];
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  for (const e of week.employees) {
    for (const a of e.allocation) {
      const accountId = accountOf.get(a.opportunityId);
      if (!accountId) {
        // Deleted or unreadable deal. Dropping it silently would post a week
        // whose total is less than the liability it came from.
        skipped.push(`${e.name}: ${money(a.amountCents)} could not be posted — its deal is gone`);
        continue;
      }
      const nowIso = new Date().toISOString();
      rows.push({
        // The table has no DB default for these three — addPurchase sets them
        // explicitly and says why. Left out, created_at is NULL, and NULLs sort
        // first on DESC, which floats payroll names to the top of the
        // payee suggestions on Mary's manual Labor-payment form — inviting a
        // second, hand-typed payout for somebody payroll already costed.
        id: randomUUID(),
        created_at: nowIso,
        updated_at: nowIso,
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
  if (skipped.length > 0)
    return {
      ok: false,
      error: `${skipped[0]}. Nothing was posted — fix that and try again, or the week would be short.`,
    };
  if (rows.length === 0) return { ok: false, error: "Nothing to post for this week." };

  const { error: insErr } = await sb.from("commercial_project_purchases").insert(rows);
  if (insErr) {
    // The previous run is already deleted at this point. Say so plainly rather
    // than leaving her to discover that a failed post also erased what was
    // there — and tell her the one action that fixes it.
    return {
      ok: false,
      error: `Nothing was written and the previous run for this week was cleared: ${insErr.message}. Press Post again once that is resolved.`,
    };
  }
  for (const r of rows)
    await logInsert("commercial_project_purchases", String(r.id), r, userId);

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
