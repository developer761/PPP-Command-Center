/**
 * Tomco's reports, the shape they actually read them in.
 *
 * Every report Brendan and Mary run in Salesforce is the same object: a table
 * of records, grouped one or two levels deep, each group carrying a count and a
 * subtotal, over a strip of grand totals — and four switches along the bottom
 * (Row Counts · Detail Rows · Subtotals · Grand Total). Eleven reports, one
 * shape. So the shape is built once, here, and each report is a DEFINITION:
 * where the rows come from, what to group by, which columns, which totals.
 *
 * This file is pure — no database, no JSX — so the grouping and the subtotals
 * can be tested with real figures. `__tests__/commercial/grouped-report.test.ts`
 * holds them to Tomco's own printed numbers.
 */

/** How a cell is drawn, and what it counts as when a subtotal is taken. */
export type ReportColumn<R> = {
  key: string;
  label: string;
  /** What the cell shows. `null` renders as Salesforce's em-dash. */
  text?: (row: R) => string | null;
  /**
   * The number this column contributes to subtotals and the grand total, in
   * CENTS for money and whole units otherwise. A column with no `amount` is
   * never summed — Salesforce only totals the columns you ask it to.
   */
  amount?: (row: R) => number;
  /** Money is right-aligned and formatted from cents; so are plain numbers. */
  kind?: "money" | "number" | "hours" | "text" | "date";
  /** Makes the cell a link, the way Salesforce links the record. */
  href?: (row: R) => string | null;
  /** Hidden below `sm` — phones get the columns that matter, not all fourteen. */
  secondary?: boolean;
};

/** One level of grouping. Two at most, which is all Tomco uses. */
export type ReportGrouping<R> = {
  key: string;
  label: string;
  /** The group a row belongs to. Empty string means "no value", like SF's "-". */
  of: (row: R) => string;
  /** Optional ordering key; falls back to the label. */
  sortBy?: (groupLabel: string) => string | number;
};

export type ReportTotal<R> = {
  label: string;
  /** Computed over ALL rows, not the visible page. */
  value: (rows: R[]) => number;
  kind?: "money" | "number" | "hours";
};

export type ReportSpec<R> = {
  /** "Balance Owed" — the name Tomco knows it by. */
  title: string;
  /** Salesforce's own report-type line: "Opportunities with Work Orders". */
  sourceLabel: string;
  /** One sentence on what the report answers. */
  blurb?: string;
  totals: ReportTotal<R>[];
  /** Offered groupings. The first is the default; the rest are the view switcher. */
  groupings: ReportGrouping<R>[][];
  columns: ReportColumn<R>[];
};

// ─── Grouping ───────────────────────────────────────────────────────────────

export type GroupNode<R> = {
  label: string;
  count: number;
  rows: R[];
  /** Subtotal per summable column, keyed by column key. */
  subtotals: Record<string, number>;
  children: GroupNode<R>[];
};

const NO_VALUE = "—";

/**
 * Roll rows up into the group tree a Salesforce report prints.
 *
 * Groups keep the order they are first met in `rows`, so the caller's sort is
 * the report's sort — Salesforce sorts the rows, then groups, and a group order
 * invented here would disagree with the column arrows.
 */
export function buildGroups<R>(
  rows: R[],
  groupings: ReportGrouping<R>[],
  columns: ReportColumn<R>[]
): GroupNode<R>[] {
  // Narrowed to the columns that HAVE an `amount`, so the reducer below needs
  // no non-null assertion to call it.
  const summable = columns.flatMap((c) => (c.amount ? [{ key: c.key, amount: c.amount }] : []));
  const subtotalsOf = (set: R[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const c of summable) out[c.key] = set.reduce((n, r) => n + (c.amount(r) || 0), 0);
    return out;
  };

  const build = (set: R[], depth: number): GroupNode<R>[] => {
    if (depth >= groupings.length) return [];
    const g = groupings[depth];
    const buckets = new Map<string, R[]>();
    for (const r of set) {
      const label = (g.of(r) ?? "").trim() || NO_VALUE;
      const bucket = buckets.get(label);
      if (bucket) bucket.push(r);
      else buckets.set(label, [r]);
    }
    return [...buckets.entries()].map(([label, groupRows]) => ({
      label,
      count: groupRows.length,
      rows: groupRows,
      subtotals: subtotalsOf(groupRows),
      children: build(groupRows, depth + 1),
    }));
  };

  return build(rows, 0);
}

/** The grand total row — the same arithmetic as a subtotal, over everything. */
export function grandTotals<R>(rows: R[], columns: ReportColumn<R>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of columns) {
    const amount = c.amount;
    if (!amount) continue;
    out[c.key] = rows.reduce((n, r) => n + (amount(r) || 0), 0);
  }
  return out;
}

/**
 * Every row under a node, however deep the grouping goes.
 *
 * `node.rows` already holds them, but reading it directly at a parent level and
 * again at a child is how a total gets counted twice; this states the intent.
 */
export function rowsUnder<R>(node: GroupNode<R>): R[] {
  return node.rows;
}
