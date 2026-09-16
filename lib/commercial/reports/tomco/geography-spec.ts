import type { ReportSpec } from "@/lib/commercial/reports/grouped/spec";
import type { GeoRow } from "@/lib/commercial/reports/geography";

/**
 * Where the work is, as rows.
 *
 * The report was two donuts and a pair of ranked lists capped at ten. The
 * places themselves — every town, what each is worth — go on top; the charts
 * stay underneath.
 */
export const GEOGRAPHY_SPEC: ReportSpec<GeoRow> = {
  title: "Where the work is",
  sourceLabel: "Jobs by location",
  blurb: "Every town Tomco has worked, with the jobs, the contract value and what it cost.",
  totals: [
    { label: "Contract", value: (rows) => rows.reduce((n, r) => n + r.contractCents, 0) },
    { label: "Cost", value: (rows) => rows.reduce((n, r) => n + r.totalCostCents, 0) },
    { label: "Jobs", kind: "number", value: (rows) => rows.reduce((n, r) => n + r.dealCount, 0) },
  ],
  groupings: [[{ key: "state", label: "State", of: (r) => r.sub ?? "—" }]],
  columns: [
    { key: "place", label: "Town", text: (r) => r.label },
    { key: "jobs", label: "Jobs", kind: "number", amount: (r) => r.dealCount },
    { key: "contract", label: "Contract", kind: "money", amount: (r) => r.contractCents },
    { key: "cost", label: "Cost", kind: "money", amount: (r) => r.totalCostCents, secondary: true },
    { key: "margin", label: "Margin", kind: "money", amount: (r) => r.marginCents },
  ],
};
