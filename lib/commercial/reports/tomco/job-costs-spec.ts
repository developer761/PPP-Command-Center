import type { ReportSpec } from "@/lib/commercial/reports/grouped/spec";
import type { JobCostRow } from "@/lib/commercial/reports/job-costs";

/**
 * Job costs as RECORDS — the jobs, what each cost, what each made.
 *
 * The report was three donuts and a set of account cards: a picture of the
 * money with the jobs themselves nowhere on it. Tomco's reports open with the
 * rows, so this goes on top and the charts stay underneath.
 *
 * The margin column carries no color. `marginPct` here is contract-based and
 * every job whose costs have not all landed reads high — painting it emerald
 * is the same mistake the Jobs report made, and this table has no
 * `provisional` flag to tell the difference.
 */
export const JOB_COSTS_SPEC: ReportSpec<JobCostRow> = {
  title: "Job costs",
  sourceLabel: "Jobs with costs",
  blurb: "Every job with money on it — the contract, what has been billed, what it has cost, and what is left.",
  totals: [
    { label: "Contract", value: (rows) => rows.reduce((n, r) => n + r.contractCents, 0) },
    { label: "Billed", value: (rows) => rows.reduce((n, r) => n + r.billedCents, 0) },
    { label: "Cost", value: (rows) => rows.reduce((n, r) => n + r.totalCostCents, 0) },
    { label: "Margin", value: (rows) => rows.reduce((n, r) => n + r.marginCents, 0) },
  ],
  groupings: [
    [{ key: "status", label: "Status", of: (r) => r.status }],
    [{ key: "job", label: "Job", of: (r) => r.dealName }],
  ],
  columns: [
    { key: "job", label: "Job", text: (r) => r.dealName, href: (r) => `/commercial/opportunities/${r.oppId}` },
    { key: "contract", label: "Contract", kind: "money", amount: (r) => r.contractCents },
    { key: "billed", label: "Billed", kind: "money", amount: (r) => r.billedCents, secondary: true },
    { key: "materials", label: "Materials", kind: "money", amount: (r) => r.buckets.materials, secondary: true },
    /**
     * EMPLOYEE LABOR HAS A COLUMN NOW, and it is the big one.
     *
     * This spec is hand-written and lists a chosen few buckets, so adding
     * `employeeLabor` to CostBuckets did not reach it — the report showed
     * Materials and Sub labor beside a Total cost that included neither
     * employee labor nor crew labor, and the columns visibly did not add up.
     * On AIREF Building #2: $89,544.39 materials + $780.00 sub labor against
     * $137,883.76 total, with $47,559 of Tomco's own payroll unaccounted for
     * on screen.
     *
     * Since the crew went W-2 this is the LARGEST cost on most jobs —
     * $507,342.39 across the book against $67,844.63 of subcontract labor —
     * so leaving it out was leaving out the answer.
     */
    { key: "employee_labor", label: "Employee labor", kind: "money", amount: (r) => r.buckets.employeeLabor, secondary: true },
    { key: "labor", label: "Sub labor", kind: "money", amount: (r) => r.buckets.subLabor, secondary: true },
    /**
     * EVERYTHING ELSE, so the row adds up.
     *
     * This table names a chosen few buckets, which meant the columns still
     * did not reach Total cost even after Employee labor was added — AIREF
     * Building #2 was left $2,593.96 short by an Equipment row with nowhere
     * to sit. Three more near-empty columns would be clutter; one catch-all
     * means the line always foots, and it keeps footing when a bucket is
     * added later without anyone remembering this file.
     *
     * Derived by subtraction rather than by listing buckets, for the same
     * reason: a list here would go stale the same way.
     */
    {
      key: "other_costs",
      label: "Other",
      kind: "money",
      amount: (r) =>
        r.totalCostCents -
        (r.buckets.materials + r.buckets.employeeLabor + r.buckets.subLabor),
      secondary: true,
    },
    { key: "cost", label: "Total cost", kind: "money", amount: (r) => r.totalCostCents },
    { key: "margin", label: "Margin", kind: "money", amount: (r) => r.marginCents },
  ],
};
