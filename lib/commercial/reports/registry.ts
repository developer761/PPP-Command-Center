/**
 * THE ONE LIST OF COMMERCIAL REPORTS.
 *
 * Before this file there were two hand-kept lists — the index cards in
 * app/commercial/reports/page.tsx and the tab bar in
 * components/commercial/report-tabs.tsx — and they drifted: Receivables shipped
 * with a card and no tab, Cash flow / Change orders / Labor with cards and no
 * tabs. Report folders (Katie, 2026-09-15) add a third consumer (access), so a
 * third copy was the moment to stop copying.
 *
 * Everything that names a report reads it from here: the index cards, the tabs,
 * the folder checklist in Settings, the access rule, and the export guard.
 * `__tests__/commercial/report-folders.test.ts` fails if a report page exists
 * with no entry here, or an entry here has no page.
 *
 * Pure data — no server imports — so client components and tests can read it.
 */

export const REPORT_KEYS = [
  "pipeline",
  "geography",
  "estimator",
  "signatures",
  "win-loss",
  "jobs",
  "job-costs",
  "labor",
  "change-orders",
  "cash-flow",
  "receivables",
  "ar-aging",
  // Tomco's own reports, reproduced from the ones they run in Salesforce.
  "balance-owed",
  "pipeline-manager",
  "scheduling",
  "open-sales",
  "purchases-by-vendor",
  "labor-payments",
  "reimbursements-out",
  "deposit-history",
  "attendance",
] as const;

export type ReportKey = (typeof REPORT_KEYS)[number];

export type ReportGroup = "sales" | "delivery" | "money";

export const REPORT_GROUPS: { key: ReportGroup; label: string; blurb: string | null }[] = [
  { key: "sales", label: "Sales", blurb: "What's coming in, and how well we win it." },
  { key: "delivery", label: "Delivery", blurb: "What the work costs once it's ours." },
  { key: "money", label: "Money", blurb: null },
];

export type ReportDef = {
  key: ReportKey;
  href: string;
  /** Card heading. */
  title: string;
  /** Short label for the tab bar and chips. */
  tabLabel: string;
  blurb: string;
  group: ReportGroup;
  /** SVG path `d` strings drawn on a 24×24 stroke icon. Strings rather than JSX
   *  so this module stays importable from anywhere. */
  icon: string[];
  /**
   * `people`: the WHOLE report is per-person performance — admin / account
   * manager only, on top of folder access (estimator). The page redirects
   * anyone else and the export 403s.
   */
  requires?: "people";
  /** The export carries per-person pay even though the page itself is open
   *  (labor: the page hides the people table, the export can't). */
  exportRequires?: "people";
};

/** A circle as a path, so every icon is a list of `d` strings. */
function circle(cx: number, cy: number, r: number): string {
  return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
}

/**
 * Registry order = the default order of the "All reports" view within each
 * group, and of the tab bar. Receivables sits before AR aging on purpose: it
 * answers Alex's question ("what is out and what is happening with it") where
 * aging answers "who is late".
 */
export const REPORTS: readonly ReportDef[] = [
  {
    key: "pipeline",
    href: "/commercial/reports/pipeline",
    title: "Pipeline",
    tabLabel: "Pipeline",
    blurb: "Open opportunities by stage — bid vs weighted value.",
    group: "sales",
    icon: ["M3 3v18h18 M7 14l3-3 4 4 5-6"],
  },
  {
    key: "geography",
    href: "/commercial/reports/geography",
    title: "Where the work is",
    tabLabel: "Geography",
    blurb: "Jobs by town, zip, and state — where the work concentrates.",
    group: "sales",
    icon: ["M12 21s-6-5.686-6-10a6 6 0 1 1 12 0c0 4.314-6 10-6 10z", circle(12, 11, 2)],
  },
  {
    key: "estimator",
    href: "/commercial/reports/estimator",
    title: "Estimator performance",
    tabLabel: "Estimator",
    blurb: "Bids sent, win rate, and how fast they go out.",
    group: "sales",
    icon: ["M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"],
    requires: "people",
  },
  {
    key: "signatures",
    href: "/commercial/reports/signatures",
    title: "Signatures",
    tabLabel: "Signatures",
    blurb: "Proposals sent for e-signature, who signed, and each audit trail.",
    group: "sales",
    icon: ["M3 17c3-3 5-8 7-8s1 6 3 6 3-3 4-3 2 2 4 2", "M3 21h18"],
  },
  {
    key: "win-loss",
    href: "/commercial/reports/win-loss",
    title: "Win / loss",
    tabLabel: "Win / Loss",
    blurb: "What we win, what we lose, and why. Quarterly review fuel.",
    group: "sales",
    icon: ["M6 9H4.5a2.5 2.5 0 0 1 0-5H6 M18 9h1.5a2.5 2.5 0 0 0 0-5H18 M6 4h12v5a6 6 0 0 1-12 0V4z M9 20h6 M12 15v5"],
  },
  {
    key: "jobs",
    href: "/commercial/reports/jobs",
    title: "Jobs",
    tabLabel: "Jobs",
    blurb: "Every job, and one full report per job — money, costs, labor, paperwork.",
    group: "delivery",
    icon: [
      "M9 3h6a1 1 0 0 1 1 1v2H8V4a1 1 0 0 1 1-1z",
      "M8 6H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-2",
      "M9 12h6 M9 16h4",
    ],
  },
  {
    key: "job-costs",
    href: "/commercial/reports/job-costs",
    title: "Job costs & profit",
    tabLabel: "Job costs",
    blurb: "Real cost vs contract per deal, GC, and company-wide.",
    group: "delivery",
    icon: ["M12 2v20 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"],
  },
  {
    key: "labor",
    href: "/commercial/reports/labor",
    title: "Labor & payroll",
    tabLabel: "Labor",
    blurb: "Approved crew hours and cost, by person and by job.",
    group: "delivery",
    icon: ["M9 21V9a3 3 0 0 1 6 0v12", "M3 21h18 M5 21V11l7-5 7 5v10"],
    exportRequires: "people",
  },
  {
    key: "change-orders",
    href: "/commercial/reports/change-orders",
    title: "Change orders & vendor spend",
    tabLabel: "Change orders",
    blurb: "Scope beyond contract, and who got paid.",
    group: "delivery",
    icon: ["M9 11l3 3L22 4", "M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"],
  },
  {
    key: "cash-flow",
    href: "/commercial/reports/cash-flow",
    title: "Cash flow & collections",
    tabLabel: "Cash flow",
    blurb: "What actually arrived, and how long it took.",
    group: "money",
    icon: ["M3 6h18v12H3z", circle(12, 12, 2.5), "M7 12h.01 M17 12h.01"],
  },
  {
    key: "receivables",
    href: "/commercial/reports/receivables",
    title: "Receivables",
    tabLabel: "Receivables",
    blurb: "Every job with money out, invoices and AIA together, with a chase note per item.",
    group: "money",
    icon: ["M3 6h18v12H3z", "M3 10h18", "M7 14h4"],
  },
  {
    key: "ar-aging",
    href: "/commercial/reports/ar-aging",
    title: "AR aging",
    tabLabel: "AR Aging",
    blurb: "What's owed by how far past due, per GC — invoices and AIA.",
    group: "money",
    icon: [circle(12, 12, 9), "M12 7v5l3 2"],
  },
  {
    key: "balance-owed",
    href: "/commercial/reports/balance-owed",
    title: "Balance Owed",
    tabLabel: "Balance Owed",
    blurb: "Tomco's own report: jobs finished or on hold with money still out, grouped the way Brendan and Mary each run it.",
    group: "money",
    icon: ["M3 6h18v12H3z", "M7 10h6", "M7 14h3"],
  },
  {
    key: "pipeline-manager",
    href: "/commercial/reports/pipeline-manager",
    title: "Opportunity Pipeline Manager",
    tabLabel: "Pipeline Manager",
    blurb: "Tomco's own report: every open bid, what it is quoted at, and who to ring about it.",
    group: "sales",
    icon: ["M4 19V5", "M8 19v-7", "M12 19V9", "M16 19v-4", "M20 19V7"],
  },
  {
    key: "scheduling",
    href: "/commercial/reports/scheduling",
    title: "Scheduling Report",
    tabLabel: "Scheduling",
    blurb: "Tomco's own report: jobs in coordination, on site or on hold, with what each still owes.",
    group: "delivery",
    icon: ["M3 5h18v16H3z", "M3 9h18", "M8 3v4", "M16 3v4"],
  },
  {
    key: "open-sales",
    href: "/commercial/reports/open-sales",
    title: "Open Sales",
    tabLabel: "Open Sales",
    blurb: "Tomco's own report: every won job not yet closed out, with contract, tax, billed and balance.",
    group: "sales",
    icon: ["M3 17l6-6 4 4 8-8", "M21 7h-5", "M21 7v5"],
  },
  {
    key: "purchases-by-vendor",
    href: "/commercial/reports/purchases-by-vendor",
    title: "Purchases by Vendor",
    tabLabel: "Purchases",
    blurb: "Tomco's own report: every purchase grouped by supplier — pick one to get that vendor's statement.",
    group: "delivery",
    icon: ["M6 2L3 6v14h18V6l-3-4z", "M3 6h18", "M16 10a4 4 0 0 1-8 0"],
  },
  {
    key: "labor-payments",
    href: "/commercial/reports/labor-payments",
    title: "Labor Payments Out",
    tabLabel: "Labor payments",
    blurb: "Tomco's own report: what went out to the crews, grouped by who was paid.",
    group: "delivery",
    icon: [circle(9, 7, 4), "M2 21v-2a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v2", "M19 8v6", "M22 11h-6"],
  },
  {
    key: "reimbursements-out",
    href: "/commercial/reports/reimbursements-out",
    title: "Reimbursements",
    tabLabel: "Reimbursements",
    blurb: "Tomco's own report: money paid back out of pocket, and who it went to.",
    group: "delivery",
    icon: ["M3 12a9 9 0 1 0 3-6.7", "M3 3v5h5"],
  },
  {
    key: "deposit-history",
    href: "/commercial/reports/deposit-history",
    title: "Partner Deposit History",
    tabLabel: "Deposits",
    blurb: "Tomco's own report: money in, grouped by the day it landed — what the bank gets reconciled against.",
    group: "money",
    icon: ["M12 3v12", "M7 10l5 5 5-5", "M4 21h16"],
  },
  {
    key: "attendance",
    href: "/commercial/reports/attendance",
    title: "Attendance",
    tabLabel: "Attendance",
    blurb: "Tomco's own report: who was on site, on which job, for how long. Hours only — the cost is on the job.",
    group: "delivery",
    icon: ["M3 5h18v16H3z", "M3 9h18", "M8 3v4", "M16 3v4", "M9 14l2 2 4-4"],
  },
];

const BY_KEY = new Map<string, ReportDef>(REPORTS.map((r) => [r.key, r]));

export function isReportKey(value: unknown): value is ReportKey {
  return typeof value === "string" && BY_KEY.has(value);
}

export function reportDef(key: ReportKey): ReportDef {
  const def = BY_KEY.get(key);
  if (!def) throw new Error(`Unknown report key: ${key}`);
  return def;
}

/** The report a /commercial/reports/<key>… pathname belongs to, or null. */
export function reportKeyFromPath(pathname: string): ReportKey | null {
  const m = /^\/commercial\/reports\/([^/?#]+)/.exec(pathname);
  return m && isReportKey(m[1]) ? m[1] : null;
}

/** Report dirs that are intentionally NOT reports (redirect stubs). */
export const NON_REPORT_DIRS: readonly string[] = ["revenue"];
