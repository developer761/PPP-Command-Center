import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import {
  SETTLED_STATUSES,
  loadRates,
  rateOn,
} from "@/lib/commercial/field-ops/labor-cost";

/**
 * Labour & payroll, across every job — the first report with a PERSON in it.
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
 *  - **W-2 only.** Subs and 1099s clock in the same table, but their cost is
 *    logged manually as a Subcontract-labour purchase. Counting both would
 *    double them here and diverge from payroll, which is W-2 only.
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
};

export type LaborJob = {
  jobId: string;
  jobName: string;
  opportunityId: string | null;
  hours: number;
  unratedHours: number;
  costCents: number;
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
  totalCostCents: number;
  /** Hours nobody could price. The honesty line on the whole report. */
  unratedHours: number;
  /** People with hours but no rate on file — whose rate to go and set. */
  unratedPeople: string[];
  people: LaborPerson[];
  jobs: LaborJob[];
  weeks: LaborWeek[];
};

/** The shape this report returns when there is nothing to report. Exported
 *  so a page can degrade one card instead of failing whole. */
export const EMPTY: LaborReport = {
  totalHours: 0,
  totalCostCents: 0,
  unratedHours: 0,
  unratedPeople: [],
  people: [],
  jobs: [],
  weeks: [],
};

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
  if (entries.length === 0) return EMPTY;

  const employeeIds = [...new Set(entries.map((e) => e.employee_id))];
  const jobIds = [...new Set(entries.map((e) => e.job_id))];

  const [{ data: empRows }, { data: jobRows }] = await Promise.all([
    sb.from("commercial_employees").select("id, display_name, worker_type").in("id", employeeIds),
    sb.from("commercial_jobs").select("id, name, job_code, opportunity_id").in("id", jobIds),
  ]);

  const emps = (empRows ?? []) as { id: string; display_name: string | null; worker_type: string }[];
  const nameById = new Map(emps.map((e) => [e.id, e.display_name?.trim() || "Unnamed"]));
  // W-2 only — see the header. A sub's cost lives in Subcontract-labour
  // purchases, and counting them here would double it.
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

  for (const e of entries) {
    if (!w2.has(e.employee_id)) continue;
    const hours = Number(e.actual_hours ?? 0);
    if (hours <= 0) continue;

    const workDate = String(e.work_date).slice(0, 10);
    const rate = rateOn(rates.get(e.employee_id), workDate);
    const cost = rate ? Math.round(hours * rate.cents) : 0;
    if (!rate) {
      unrated += hours;
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
      jobs: new Set<string>(),
    };
    p.hours += hours;
    p.costCents += cost;
    if (rate) p.ratedHours += hours;
    else p.unratedHours += hours;
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
      crewCount: 0,
      crew: new Set<string>(),
    };
    row.hours += hours;
    row.costCents += cost;
    if (!rate) row.unratedHours += hours;
    row.crew.add(e.employee_id);
    byJob.set(e.job_id, row);

    const wk = weekStartOf(workDate);
    const w = byWeek.get(wk) ?? { weekStart: wk, hours: 0, costCents: 0 };
    w.hours += hours;
    w.costCents += cost;
    byWeek.set(wk, w);
  }

  const round1 = (n: number) => Math.round(n * 10) / 10;

  return {
    totalHours: round1(totalHours),
    totalCostCents: totalCost,
    unratedHours: round1(unrated),
    unratedPeople: [...unratedPeople].sort(),
    // Costliest first — the question is where the money went, not who is
    // alphabetically first.
    people: [...byPerson.values()]
      .map(({ jobs, ...p }) => ({ ...p, hours: round1(p.hours), ratedHours: round1(p.ratedHours), unratedHours: round1(p.unratedHours), jobCount: jobs.size }))
      .sort((a, b) => b.costCents - a.costCents || b.hours - a.hours),
    jobs: [...byJob.values()]
      .map(({ crew, ...j }) => ({ ...j, hours: round1(j.hours), unratedHours: round1(j.unratedHours), crewCount: crew.size }))
      .sort((a, b) => b.costCents - a.costCents || b.hours - a.hours),
    // Oldest week first — a labour trend reads left to right.
    weeks: [...byWeek.values()]
      .map((w) => ({ ...w, hours: round1(w.hours) }))
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart)),
  };
}
