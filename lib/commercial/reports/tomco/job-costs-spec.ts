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
    { key: "labor", label: "Sub labor", kind: "money", amount: (r) => r.buckets.subLabor, secondary: true },
    { key: "cost", label: "Total cost", kind: "money", amount: (r) => r.totalCostCents },
    { key: "margin", label: "Margin", kind: "money", amount: (r) => r.marginCents },
  ],
};
