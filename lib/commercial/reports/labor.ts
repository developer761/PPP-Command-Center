import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import {
  SETTLED_STATUSES,
  loadRates,
  rateOn,
} from "@/lib/commercial/field-ops/labor-cost";

/**
 * Labor & payroll, across every job — the first report with a PERSON in it.
 *
 * Field Ops has held all of this since it shipped and no report read it, so
 * the only way to answer "where did the hours go last month" was to open jobs
 * one at a time.
 *
 * Three deliberate constraints, each inherited rather than re-decided, because
 * a report that counts differently from the deal page is worse than no report:
 *
 *  - **Settled entries only** (`approved` / `exported`). A submitted or
 *    questioned entry is not yet a cost. Same constant the deal P&L uses.
 *  - **W-2 cost only.** Subs and 1099s clock in the same table, but their cost
 *    is logged as a Subcontract-labor purchase. Pricing their hours from a rate
 *    card AND counting the payout would double them.
 *
 *    This used to be a W-2 filter on the whole report, and for Tomco that made
 *    it permanently blank. Every one of their 23 crew is `worker_type = 'sub'`
 *    — they pay crews through labor companies, not payroll — so the filter
 *    excluded 100% of the workforce, and the report showed nothing while
 *    $555,789.53 of labor payouts sat in the book with no report reading them.
 *    Katie, 2026-09-17: "the Labor payouts from Salesforce aren't showing up in
 *    Command Center."
 *
 *    So the rule is narrowed to what it was actually protecting. HOURS are
 *    counted for everybody — attendance is the only record of them and nothing
 *    else counts them, so there is nothing to double. COST stays split in two
 *    and is NEVER added up: rate-priced W-2 cost, and what was actually paid
 *    out to crews. That is the same rule the handbook states on Mary's Labor
 *    payments page — "the crew's HOURS are on Attendance; what you PAID them is
 *    here; adding both would charge every job twice."
 *  - **Effective-dated rates.** A raise last month does not restate a job
 *    worked before it, so each entry is priced at the rate in force on its own
 *    work date.
 *
 * Unrated hours are carried separately rather than folded into $0. A worker
 * with no rate on file makes the cost column an UNDERSTATEMENT, and a payroll
 * number that is quietly low is the kind people plan against.
 */

export type LaborPerson = {
  employeeId: string;
  name: string;
  hours: number;
  ratedHours: number;
  /** Hours worked with no cost rate on file — cost below is short by these. */
  unratedHours: number;
  costCents: number;
  /** How many distinct jobs they touched in the period. */
  jobCount: number;
  /**
   * Paid through a labor company rather than payroll.
   *
   * Their `costCents` is 0 and that is correct, not missing: what they cost is
   * the payout to their company, which is money paid to a COMPANY and cannot be
   * split back out per person without inventing the split. The payout total
   * carries it instead.
   */
  isSub: boolean;
};

/** What was actually paid out to one crew or labor company in the period. */
export type LaborPayout = {
  /** The company as it is written on the payment — "Tomco Labor - Rob". */
  vendor: string;
  amountCents: number;
  /** How many payments made it up. */
  count: number;
  /** Distinct jobs it was paid against. */
  jobCount: number;
};

export type LaborJob = {
  jobId: string;
  jobName: string;
  opportunityId: string | null;
  hours: number;
  unratedHours: number;
  costCents: number;
  /** Paid out to crews against this job. Separate from costCents, never added. */
  payoutCents: number;
  /** Distinct people who worked it. */
  crewCount: number;
};

export type LaborWeek = {
  /** Monday of the week, as an ET calendar date. */
  weekStart: string;
  hours: number;
  costCents: number;
};

export type LaborReport = {
  totalHours: number;
  /** Of those hours, the ones worked by crews paid through a labor company. */
  subHours: number;
  /** Rate-priced W-2 cost. NEVER add this to payoutCents — see the header. */
  totalCostCents: number;
  /** What was actually paid out to crews in the period. Tomco's real labor cost. */
  payoutCents: number;
  /** Hours nobody could price. The honesty line on the whole report. */
  unratedHours: number;
  /** People with hours but no rate on file — whose rate to go and set. */
  unratedPeople: string[];
  people: LaborPerson[];
  payouts: LaborPayout[];
  jobs: LaborJob[];
  weeks: LaborWeek[];
};

/** The shape this report returns when there is nothing to report. Exported
 *  so a page can degrade one card instead of failing whole. */
export const EMPTY: LaborReport = {
  totalHours: 0,
  subHours: 0,
  totalCostCents: 0,
  payoutCents: 0,
  unratedHours: 0,
  unratedPeople: [],
  people: [],
  payouts: [],
  jobs: [],
  weeks: [],
};

/**
 * How one approved shift lands on this report. THE rule that broke.
 *
 * Pulled out as a pure function because it is the whole bug: the loop used to
 * open with `if (!w2.has(id)) continue`, which threw away a sub's HOURS along
 * with their cost. The cost half was right — a sub is paid through their labor
 * company, and pricing their hours from a rate card as well would double them.
 * The hours half was wrong, and for a shop where everybody is a sub it emptied
 * the report.
 *
 *   hours  — always counted. Attendance is the only record of them.
 *   cost   — W-2 only, priced at the rate in force on the work date.
 *   unrated— W-2 only. A sub has no rate BY DESIGN, and listing them as
 *            "no rate on file" sends somebody chasing 23 rates that should
 *            never exist.
 */
export function laborLineFor(line: { isW2: boolean; hours: number; rateCents: number | null }): {
  hours: number;
  costCents: number;
  unratedHours: number;
} {
  const hours = Number(line.hours ?? 0);
  if (!(hours > 0)) return { hours: 0, costCents: 0, unratedHours: 0 };
  if (!line.isW2) return { hours, costCents: 0, unratedHours: 0 };
  if (line.rateCents == null) return { hours, costCents: 0, unratedHours: hours };
  return { hours, costCents: Math.round(hours * line.rateCents), unratedHours: 0 };
}

/** Monday of the ET week containing a YYYY-MM-DD. Pure string date maths, so
 *  no timezone can shift a Sunday shift into the previous week. */
function weekStartOf(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  // getUTCDay: 0 = Sunday. Payroll weeks here run Monday–Sunday.
  const shift = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - shift);
  return dt.toISOString().slice(0, 10);
}

export async function getLaborReport(range: {
  fromYmd: string;
  toYmd: string;
}): Promise<LaborReport> {
  const sb = commercialDb();

  const entries = await paginateAll<{
    employee_id: string;
    job_id: string;
    work_date: string;
    actual_hours: number;
  }>(() =>
    sb
      .from("commercial_time_entries")
      .select("employee_id, job_id, work_date, actual_hours")
      .gte("work_date", range.fromYmd)
      .lte("work_date", range.toYmd)
      .in("status", SETTLED_STATUSES as unknown as string[])
      .order("work_date")
      .order("id")
  );

  /**
   * What was paid out to crews in the period.
   *
   * Read alongside the hours rather than instead of them, and reported on its
   * own line. `purchased_at` is the date of the payment, which is the date this
   * report's period means for money — a payment made in September for August's
   * work is September's outgoing.
   */
  const payoutRows = await paginateAll<{
    vendor: string | null;
    amount_cents: number;
    opportunity_id: string | null;
  }>(() =>
    sb
      .from("commercial_project_purchases")
      .select("vendor, amount_cents, opportunity_id, id")
      .in("category", ["labor", "employee_labor"])
      .is("deleted_at", null)
      .gte("purchased_at", range.fromYmd)
      .lte("purchased_at", range.toYmd)
      .order("id")
  );

  const payoutByVendor = new Map<string, LaborPayout & { jobs: Set<string> }>();
  const payoutByOpp = new Map<string, number>();
  let payoutCents = 0;
  for (const p of payoutRows) {
    const cents = Number(p.amount_cents ?? 0);
    payoutCents += cents;
    const vendor = (p.vendor ?? "").trim() || "Unnamed crew";
    const v = payoutByVendor.get(vendor) ?? { vendor, amountCents: 0, count: 0, jobCount: 0, jobs: new Set<string>() };
    v.amountCents += cents;
    v.count += 1;
    if (p.opportunity_id) v.jobs.add(p.opportunity_id);
    payoutByVendor.set(vendor, v);
    if (p.opportunity_id) payoutByOpp.set(p.opportunity_id, (payoutByOpp.get(p.opportunity_id) ?? 0) + cents);
  }
  const payouts: LaborPayout[] = [...payoutByVendor.values()]
    .map(({ jobs, ...v }) => ({ ...v, jobCount: jobs.size }))
    .sort((a, b) => b.amountCents - a.amountCents);

  // Money with no hours behind it is still money, and used to vanish: the old
  // early return bailed the moment there were no time entries, so a period in
  // which crews were paid but nobody's attendance had been entered reported a
  // flat zero.
  if (entries.length === 0) {
    return payoutRows.length === 0 ? EMPTY : { ...EMPTY, payoutCents, payouts };
  }

  const employeeIds = [...new Set(entries.map((e) => e.employee_id))];
  const jobIds = [...new Set(entries.map((e) => e.job_id))];

  const [{ data: empRows }, { data: jobRows }] = await Promise.all([
    sb.from("commercial_employees").select("id, display_name, worker_type").in("id", employeeIds),
    sb.from("commercial_jobs").select("id, name, job_code, opportunity_id").in("id", jobIds),
  ]);

  const emps = (empRows ?? []) as { id: string; display_name: string | null; worker_type: string }[];
  const nameById = new Map(emps.map((e) => [e.id, e.display_name?.trim() || "Unnamed"]));
  // Who is priced from the rate card, and who is paid through a company.
  // Everybody's HOURS count; only W-2 hours turn into `costCents`.
  const w2 = new Set(emps.filter((e) => e.worker_type === "w2").map((e) => e.id));

  const jobs = (jobRows ?? []) as { id: string; name: string | null; job_code: string | null; opportunity_id: string | null }[];
  const jobById = new Map(jobs.map((j) => [j.id, j]));

  const rates = await loadRates(employeeIds);

  const byPerson = new Map<string, LaborPerson & { jobs: Set<string> }>();
  const byJob = new Map<string, LaborJob & { crew: Set<string> }>();
  const byWeek = new Map<string, LaborWeek>();
  let totalHours = 0;
  let totalCost = 0;
  let unrated = 0;
  const unratedPeople = new Set<string>();

  let subHours = 0;
  for (const e of entries) {
    const isW2 = w2.has(e.employee_id);
    const workDate = String(e.work_date).slice(0, 10);
    const rate = isW2 ? rateOn(rates.get(e.employee_id), workDate) : null;
    const line = laborLineFor({ isW2, hours: Number(e.actual_hours ?? 0), rateCents: rate?.cents ?? null });
    const { hours } = line;
    const cost = line.costCents;
    if (hours <= 0) continue;
    if (!isW2) subHours += hours;
    if (line.unratedHours > 0) {
      unrated += line.unratedHours;
      unratedPeople.add(nameById.get(e.employee_id) ?? "Unnamed");
    }
    totalHours += hours;
    totalCost += cost;

    const p = byPerson.get(e.employee_id) ?? {
      employeeId: e.employee_id,
      name: nameById.get(e.employee_id) ?? "Unnamed",
      hours: 0,
      ratedHours: 0,
      unratedHours: 0,
      costCents: 0,
      jobCount: 0,
      isSub: !isW2,
      jobs: new Set<string>(),
    };
    p.hours += hours;
    p.costCents += cost;
    if (rate) p.ratedHours += hours;
    p.unratedHours += line.unratedHours;
    p.jobs.add(e.job_id);
    byPerson.set(e.employee_id, p);

    const j = jobById.get(e.job_id);
    const row = byJob.get(e.job_id) ?? {
      jobId: e.job_id,
      jobName: j?.name?.trim() || j?.job_code || "Untitled job",
      opportunityId: j?.opportunity_id ?? null,
      hours: 0,
      unratedHours: 0,
      costCents: 0,
      payoutCents: j?.opportunity_id ? (payoutByOpp.get(j.opportunity_id) ?? 0) : 0,
      crewCount: 0,
      crew: new Set<string>(),
    };
    row.hours += hours;
    row.costCents += cost;
    row.unratedHours += line.unratedHours;
    row.crew.add(e.employee_id);
    byJob.set(e.job_id, row);

    const wk = weekStartOf(workDate);
    const w = byWeek.get(wk) ?? { weekStart: wk, hours: 0, costCents: 0 };
    w.hours += hours;
    w.costCents += cost;
    byWeek.set(wk, w);
  }

  /**
   * Jobs that were PAID in the period but have no hours in it.
   *
   * Without this the By-job table silently came up short of its own total —
   * $185,106.29 of $186,133.51 over 90 days — because a job only got a row if
   * a time entry put it there. That happens routinely: a crew finishes in
   * August and the labor company invoices in September, so the payment lands in
   * a period the hours do not. Money you can see in the total and cannot find
   * in the list is the thing that makes somebody stop trusting a report.
   */
  const coveredOpps = new Set([...byJob.values()].map((j) => j.opportunityId).filter(Boolean) as string[]);
  const orphanOppIds = [...payoutByOpp.keys()].filter((id) => !coveredOpps.has(id));
  if (orphanOppIds.length > 0) {
    const { data: orphanOpps } = await sb
      .from("commercial_opportunities")
      .select("id, title, client_name, title_override, title_override_mode, property_street, account_id")
      .in("id", orphanOppIds);
    const { data: orphanAccts } = await sb
      .from("commercial_accounts")
      .select("id, company_name")
      .in("id", [...new Set(((orphanOpps ?? []) as { account_id: string }[]).map((o) => o.account_id))]);
    const acctName = new Map(
      ((orphanAccts ?? []) as { id: string; company_name: string | null }[]).map((a) => [a.id, a.company_name])
    );
    const { derivedOppName } = await import("@/lib/commercial/opportunities/db");
    for (const o of (orphanOpps ?? []) as {
      id: string;
      title: string | null;
      account_id: string;
      client_name: string | null;
      title_override: string | null;
      title_override_mode: string | null;
      property_street: string | null;
    }[]) {
      byJob.set(`opp:${o.id}`, {
        jobId: `opp:${o.id}`,
        jobName: derivedOppName({ ...o, title: o.title ?? "" }, acctName.get(o.account_id) ?? null),
        opportunityId: o.id,
        hours: 0,
        unratedHours: 0,
        costCents: 0,
        payoutCents: payoutByOpp.get(o.id) ?? 0,
        crewCount: 0,
        crew: new Set<string>(),
      });
    }
  }

  const round1 = (n: number) => Math.round(n * 10) / 10;

  return {
    totalHours: round1(totalHours),
    subHours: round1(subHours),
    totalCostCents: totalCost,
    payoutCents,
    payouts,
    unratedHours: round1(unrated),
    unratedPeople: [...unratedPeople].sort(),
    // Costliest first — the question is where the money went, not who is
    // alphabetically first. HOURS break the tie, and for a sub they decide it
    // outright: their cost here is 0 by design, so sorting on cost alone left
    // every one of Tomco's 23 crew in whatever order the map happened to hold.
    people: [...byPerson.values()]
      .map(({ jobs, ...p }) => ({ ...p, hours: round1(p.hours), ratedHours: round1(p.ratedHours), unratedHours: round1(p.unratedHours), jobCount: jobs.size }))
      .sort((a, b) => b.costCents - a.costCents || b.hours - a.hours || a.name.localeCompare(b.name)),
    jobs: [...byJob.values()]
      .map(({ crew, ...j }) => ({ ...j, hours: round1(j.hours), unratedHours: round1(j.unratedHours), crewCount: crew.size }))
      // Ordered by the LARGER of the two money columns, never by their sum —
      // the two are different accounts of the same work and adding them, even
      // just to sort, is the double-count this report is built to avoid.
      .sort(
        (a, b) =>
          Math.max(b.costCents, b.payoutCents) - Math.max(a.costCents, a.payoutCents) ||
          b.hours - a.hours ||
          a.jobName.localeCompare(b.jobName)
      ),
    // Oldest week first — a labor trend reads left to right.
    weeks: [...byWeek.values()]
      .map((w) => ({ ...w, hours: round1(w.hours) }))
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart)),
  };
}
