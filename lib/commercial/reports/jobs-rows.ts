/**
 * The Jobs report — pure row logic (grouping, search, period, sort, totals).
 *
 * Karan, 2026-09-15: *"we go on the reports tab and then we choose a job and
 * have reports for that job only. We should have an overview page for all the
 * jobs, plus like an all jobs in reports that has reports for all jobs combined
 * or in a certain period."*
 *
 * Everything here is a pure transformation over rows the server already loaded
 * (lib/commercial/reports/jobs.ts does the I/O in ONE batch via listProjects).
 * Kept separate so the filtering / sorting / totalling is testable directly —
 * vitest here is pure-logic, and the totals row across every job is exactly the
 * kind of arithmetic that is wrong in silence.
 *
 * NOT re-derived here: money. Every cents figure on a row comes from
 * `listProjects` (the same source the deal page's `getProjectFinancials` mirrors
 * and the Job-costs report already uses), and margin comes from `marginFrom` —
 * the ONE billed-based margin (decision D2). A second definition of "margin" on
 * a new screen is how the platform ended up with three of them.
 */

import { marginFrom } from "@/lib/commercial/projects/financials";
import { dealPhase, type DealPhase } from "@/lib/commercial/opportunities/constants";
import { purchaseCategoryLabel } from "@/lib/commercial/purchases/constants";

// ─── Status grouping ────────────────────────────────────────────────────────

/**
 * The four buckets a job can be in on this report. They PARTITION every deal —
 * no overlap, no gap — so the group counts always add up to the job count.
 *
 * `delivery` deliberately includes a won job that hasn't started yet
 * (pre_sale_closed + won): it is under contract, which is the question this
 * report answers. `dealPhase` keeps them apart for the deal page's own
 * purposes; here "we sold it and it isn't finished" is one answer.
 */
export type JobGroup = "open" | "delivery" | "closed" | "lost";

export const JOB_GROUPS: { key: JobGroup; label: string; blurb: string }[] = [
  { key: "open", label: "Open", blurb: "Bidding — not yet won or lost." },
  { key: "delivery", label: "In delivery", blurb: "Won and under contract." },
  { key: "closed", label: "Closed", blurb: "Finished jobs." },
  { key: "lost", label: "Lost", blurb: "Bids we didn't get." },
];

export function jobStatusGroup(o: { status: string | null | undefined; sub_status: string | null | undefined }): JobGroup {
  if (o.status === "post_sale_closed") return "closed";
  const phase: DealPhase = dealPhase(o);
  if (phase === "lost") return "lost";
  if (phase === "won_not_started" || phase === "in_delivery") return "delivery";
  return "open";
}

/** `?group=` values: the four buckets plus "all". */
export type JobGroupFilter = JobGroup | "all";

export function resolveGroupFilter(raw: string | string[] | undefined): JobGroupFilter {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === "open" || v === "delivery" || v === "closed" || v === "lost" ? v : "all";
}

// ─── The row ────────────────────────────────────────────────────────────────

export type JobsReportRow = {
  oppId: string;
  accountId: string;
  /** The GC. */
  accountName: string;
  jobName: string;
  projectNumber: string | null;
  dealNumber: string | null;
  /** One-line site address, or null when the job has none of its own. */
  address: string | null;
  status: string;
  subStatus: string | null;
  group: JobGroup;
  /**
   * The day this job belongs to: the day it was decided (won or lost), else the
   * day it was created. One date, so the period filter can never double-count a
   * job or drop one — and the column says which it is.
   */
  jobYmd: string | null;
  /** True when `jobYmd` is the decided date rather than the created date. */
  jobYmdIsDecided: boolean;
  contractCents: number;
  hasContract: boolean;
  /** PRE-TAX billed (invoices' subtotals + AIA), matching the contract's basis. */
  billedCents: number;
  collectedCents: number;
  openBalanceCents: number;
  retainageHeldCents: number;
  costCents: number;
  /** Billed − cost (decision D2), via `marginFrom`. */
  marginCents: number;
  marginPct: number | null;
  /**
   * True when the percentage above is not a measured margin — no costs are
   * booked against the job, so it is everything billed rather than profit.
   * `marginFrom` has always returned this; the row dropped it, and the table
   * painted a confident emerald "100%" on any job whose costs had not landed.
   */
  marginProvisional: boolean;
  /** Settled crew hours on the job (rated + unrated). */
  laborHours: number;
  /** Of those, hours with no cost rate on file — labor cost is understated. */
  unratedHours: number;
  invoiceCount: number;
  pendingCoCount: number;
};

// ─── Search ─────────────────────────────────────────────────────────────────

/** Everything a search term is matched against, lower-cased once. */
function haystack(r: JobsReportRow): string {
  return [r.jobName, r.accountName, r.projectNumber, r.dealNumber, r.address]
    .filter(Boolean)
    // A newline can never appear in a search token (tokens are split on
    // whitespace), so it separates the fields without ever being matched
    // across. A NUL would do the same and makes the source file binary.
    .join("\n")
    .toLowerCase();
}

/**
 * Split the query on whitespace and require EVERY token — "alt roof" finds
 * "Altman · Roof deck" without needing the words adjacent, which is how people
 * actually half-remember a job name.
 */
export function matchesJobSearch(r: JobsReportRow, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const hay = haystack(r);
  return tokens.every((t) => hay.includes(t));
}

// ─── Filtering ──────────────────────────────────────────────────────────────

export type JobsFilter = {
  q?: string;
  group?: JobGroupFilter;
  /** GC account id, or "all". */
  gc?: string;
  /** Inclusive YYYY-MM-DD window on `jobYmd`. Both null = no period filter. */
  fromYmd?: string | null;
  toYmd?: string | null;
};

/**
 * A job with NO date at all can't be placed in a window. It is kept out of a
 * narrowed period rather than shown in every one — a dateless row appearing in
 * "Today" and in "Last year" is the sort of thing that makes people stop
 * trusting a filter.
 */
export function withinPeriod(jobYmd: string | null, fromYmd?: string | null, toYmd?: string | null): boolean {
  if (!fromYmd && !toYmd) return true;
  if (!jobYmd) return false;
  if (fromYmd && jobYmd < fromYmd) return false;
  if (toYmd && jobYmd > toYmd) return false;
  return true;
}

export function filterJobRows(rows: readonly JobsReportRow[], f: JobsFilter): JobsReportRow[] {
  const group = f.group ?? "all";
  const gc = f.gc && f.gc !== "all" ? f.gc : null;
  const q = f.q ?? "";
  return rows.filter(
    (r) =>
      (group === "all" || r.group === group) &&
      (gc === null || r.accountId === gc) &&
      withinPeriod(r.jobYmd, f.fromYmd, f.toYmd) &&
      matchesJobSearch(r, q)
  );
}

// ─── Sorting ────────────────────────────────────────────────────────────────

export type JobSortKey =
  | "job"
  | "gc"
  | "date"
  | "contract"
  | "billed"
  | "collected"
  | "open"
  | "cost"
  | "margin"
  | "hours";

export type SortDir = "asc" | "desc";

export const JOB_SORTS: { key: JobSortKey; label: string; numeric: boolean }[] = [
  { key: "job", label: "Job", numeric: false },
  { key: "gc", label: "GC", numeric: false },
  { key: "date", label: "Job date", numeric: false },
  { key: "contract", label: "Contract", numeric: true },
  { key: "billed", label: "Billed", numeric: true },
  { key: "collected", label: "Collected", numeric: true },
  { key: "open", label: "Open balance", numeric: true },
  { key: "cost", label: "Cost", numeric: true },
  { key: "margin", label: "Margin %", numeric: true },
  { key: "hours", label: "Hours", numeric: true },
];

const SORT_KEYS = new Set(JOB_SORTS.map((s) => s.key));

export function resolveSort(rawKey: string | string[] | undefined, rawDir: string | string[] | undefined): { key: JobSortKey; dir: SortDir } {
  const k = Array.isArray(rawKey) ? rawKey[0] : rawKey;
  const d = Array.isArray(rawDir) ? rawDir[0] : rawDir;
  const key = k && SORT_KEYS.has(k as JobSortKey) ? (k as JobSortKey) : "contract";
  const def = JOB_SORTS.find((s) => s.key === key)!;
  // Money and hours read biggest-first; names and dates read A→Z / oldest-first
  // unless asked otherwise, which is what people expect of each.
  const dir: SortDir = d === "asc" || d === "desc" ? d : def.numeric ? "desc" : "asc";
  return { key, dir };
}

/** The default direction a column takes on its FIRST click. */
export function defaultDirFor(key: JobSortKey): SortDir {
  return JOB_SORTS.find((s) => s.key === key)?.numeric ? "desc" : "asc";
}

function textOf(r: JobsReportRow, key: JobSortKey): string | null {
  if (key === "job") return r.jobName;
  if (key === "gc") return r.accountName;
  if (key === "date") return r.jobYmd;
  return null;
}

function numberOf(r: JobsReportRow, key: JobSortKey): number | null {
  switch (key) {
    case "contract": return r.contractCents;
    case "billed": return r.billedCents;
    case "collected": return r.collectedCents;
    case "open": return r.openBalanceCents;
    case "cost": return r.costCents;
    // null (no margin can be stated) is NOT 0 — a job with nothing billed must
    // not sort between a loss and a profit as though it broke even.
    case "margin": return r.marginPct;
    case "hours": return r.laborHours;
    default: return null;
  }
}

/**
 * Stable sort. A missing value always sinks to the BOTTOM, in both directions —
 * "sort by margin" should surface the jobs that have one, not fill the first
 * screen with blanks because they happen to compare low.
 */
export function sortJobRows(rows: readonly JobsReportRow[], key: JobSortKey, dir: SortDir): JobsReportRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const numeric = JOB_SORTS.find((s) => s.key === key)?.numeric ?? false;
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      let cmp = 0;
      if (numeric) {
        const x = numberOf(a.r, key);
        const y = numberOf(b.r, key);
        if (x === null && y === null) cmp = 0;
        else if (x === null) return 1;
        else if (y === null) return -1;
        else cmp = (x - y) * sign;
      } else {
        const x = textOf(a.r, key);
        const y = textOf(b.r, key);
        if (x === null && y === null) cmp = 0;
        else if (x === null) return 1;
        else if (y === null) return -1;
        else cmp = x.localeCompare(y, "en", { numeric: true, sensitivity: "base" }) * sign;
      }
      // Ties break on the job name so the order is deterministic run to run —
      // a table that reshuffles between refreshes reads as broken.
      if (cmp !== 0) return cmp;
      const byName = a.r.jobName.localeCompare(b.r.jobName, "en", { numeric: true, sensitivity: "base" });
      return byName !== 0 ? byName : a.i - b.i;
    })
    .map((x) => x.r);
}

// ─── Totals ─────────────────────────────────────────────────────────────────

export type JobsTotals = {
  jobCount: number;
  gcCount: number;
  contractCents: number;
  /** How many of those jobs have a contract figure at all. */
  withContract: number;
  billedCents: number;
  collectedCents: number;
  openBalanceCents: number;
  retainageHeldCents: number;
  costCents: number;
  marginCents: number;
  marginPct: number | null;
  /** The caveat `marginFrom` attaches (nothing billed / no costs booked). */
  marginLabel: string;
  marginCaveat: string | null;
  laborHours: number;
  unratedHours: number;
  byGroup: Record<JobGroup, number>;
};

/**
 * Roll a filtered set up. Margin is computed on the SUMS through `marginFrom`,
 * never averaged across rows — an average of percentages weights a $2k job the
 * same as a $2m one and is simply a different (wrong) number.
 */
export function summarizeJobRows(rows: readonly JobsReportRow[]): JobsTotals {
  const byGroup: Record<JobGroup, number> = { open: 0, delivery: 0, closed: 0, lost: 0 };
  const gcs = new Set<string>();
  let contractCents = 0, withContract = 0, billedCents = 0, collectedCents = 0;
  let openBalanceCents = 0, retainageHeldCents = 0, costCents = 0;
  let laborHours = 0, unratedHours = 0;

  for (const r of rows) {
    byGroup[r.group] += 1;
    if (r.accountId) gcs.add(r.accountId);
    contractCents += r.contractCents;
    if (r.hasContract) withContract += 1;
    billedCents += r.billedCents;
    collectedCents += r.collectedCents;
    openBalanceCents += r.openBalanceCents;
    retainageHeldCents += r.retainageHeldCents;
    costCents += r.costCents;
    laborHours += r.laborHours;
    unratedHours += r.unratedHours;
  }

  const m = marginFrom(billedCents, costCents);
  return {
    jobCount: rows.length,
    gcCount: gcs.size,
    contractCents,
    withContract,
    billedCents,
    collectedCents,
    openBalanceCents,
    retainageHeldCents,
    costCents,
    marginCents: m.cents,
    marginPct: m.pct,
    marginLabel: m.label,
    marginCaveat: m.caveat,
    laborHours: round2(laborHours),
    unratedHours: round2(unratedHours),
    byGroup,
  };
}

/** Hours are decimal; summing many of them drifts into 0.30000000000000004. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The GC list for the picker — only GCs that actually have a job, counted. */
export function gcOptions(rows: readonly JobsReportRow[]): { id: string; name: string; count: number }[] {
  const by = new Map<string, { id: string; name: string; count: number }>();
  for (const r of rows) {
    if (!r.accountId) continue;
    const cur = by.get(r.accountId);
    if (cur) cur.count += 1;
    else by.set(r.accountId, { id: r.accountId, name: r.accountName || "Unassigned account", count: 1 });
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

/** One-line site address from the per-job address fields, or null. */
export function jobAddressLine(o: {
  property_street: string | null;
  property_city: string | null;
  property_state: string | null;
  property_zip: string | null;
}): string | null {
  const street = (o.property_street ?? "").trim();
  const city = (o.property_city ?? "").trim();
  const state = (o.property_state ?? "").trim();
  const zip = (o.property_zip ?? "").trim();
  const tail = [city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const line = [street, tail].filter(Boolean).join(", ");
  return line || null;
}

// ─── Cost roll-ups ──────────────────────────────────────────────────────────

export type VendorSpendRow = { vendor: string; cents: number; count: number };
export type CategorySpendRow = { key: string; label: string; cents: number; count: number };

type PurchaseLike = { category: string; vendor: string | null; amount_cents: number };

/**
 * Purchases grouped by category, biggest first. Computed from the SAME rows the
 * itemised list renders, so the summary and the list can't tell different
 * stories about the same window — which is what happens when the summary comes
 * from an aggregate query and the list from a filtered one.
 */
export function spendByCategory(rows: readonly PurchaseLike[]): CategorySpendRow[] {
  const by = new Map<string, CategorySpendRow>();
  for (const r of rows) {
    const key = r.category;
    const cur = by.get(key) ?? { key, label: purchaseCategoryLabel(key), cents: 0, count: 0 };
    cur.cents += Number(r.amount_cents ?? 0);
    cur.count += 1;
    by.set(key, cur);
  }
  return [...by.values()].sort((a, b) => b.cents - a.cents || a.label.localeCompare(b.label));
}

/** Purchases grouped by vendor name, biggest first. Unnamed rows gather under
 *  one honest label rather than being silently dropped. */
export function spendByVendor(rows: readonly PurchaseLike[]): VendorSpendRow[] {
  const by = new Map<string, VendorSpendRow>();
  for (const r of rows) {
    const vendor = (r.vendor ?? "").trim() || "No vendor recorded";
    const cur = by.get(vendor) ?? { vendor, cents: 0, count: 0 };
    cur.cents += Number(r.amount_cents ?? 0);
    cur.count += 1;
    by.set(vendor, cur);
  }
  return [...by.values()].sort((a, b) => b.cents - a.cents || a.vendor.localeCompare(b.vendor));
}

/** Total of a spend roll-up — used by the page and the CSV, so the two agree. */
export function spendTotal(rows: readonly { cents: number }[]): number {
  return rows.reduce((n, r) => n + r.cents, 0);
}

/** The day a job belongs to: decided (won/lost), else created. */
export function jobDate(o: { decided_at: string | null; created_at: string }): { ymd: string | null; isDecided: boolean } {
  const decided = (o.decided_at ?? "").slice(0, 10);
  if (decided) return { ymd: decided, isDecided: true };
  const created = (o.created_at ?? "").slice(0, 10);
  return { ymd: created || null, isDecided: false };
}
