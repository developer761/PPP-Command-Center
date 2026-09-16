/**
 * A Tomco report, drawn the way Tomco reads it.
 *
 * Salesforce prints: a totals strip, then a table of records grouped one or two
 * levels deep, each group showing its count and a subtotal row, and a grand
 * total at the foot. Brendan calls GCs straight off his; Mary reconciles
 * vendors off hers. So the record rows are the report — not a chart of them.
 *
 * Eleven reports share this component. What differs is the ReportSpec.
 *
 * On a phone the table scrolls sideways inside its own box (never the page) and
 * `secondary` columns drop out, so the first two columns and the money stay
 * readable at 390px.
 */

import Link from "next/link";
import {
  buildGroups,
  grandTotals,
  type GroupNode,
  type ReportColumn,
  type ReportGrouping,
  type ReportSpec,
} from "@/lib/commercial/reports/grouped/spec";
import { formatCentsFull } from "@/lib/commercial/invoices/format";

type ColumnKind = ReportColumn<never>["kind"];

function fmt(kind: ColumnKind, n: number): string {
  if (kind === "money") return formatCentsFull(n);
  if (kind === "hours") return `${Math.round(n * 100) / 100}h`;
  return (Math.round(n * 100) / 100).toLocaleString();
}

// Deliberately not `ReportColumn<unknown>`: a column is generic in its row
// type, and `unknown` is not assignable to that. Neither of these reads the
// row, only the column's own shape.
const isNumeric = <R,>(c: ReportColumn<R>) => !!c.amount;

function Cell<R>({ col, row }: { col: ReportColumn<R>; row: R }) {
  const href = col.href?.(row) ?? null;
  const text = col.text ? col.text(row) : col.amount ? fmt(col.kind, col.amount(row)) : null;
  const body = text === null || text === "" ? <span className="text-ppp-charcoal-300">—</span> : text;
  return (
    <td
      className={`px-3 py-2 align-top text-[12.5px] ${isNumeric(col) ? "text-right tabular-nums whitespace-nowrap" : ""} ${
        col.secondary ? "hidden sm:table-cell" : ""
      }`}
    >
      {href ? (
        <Link href={href} className="font-semibold text-cc-brand-700 hover:underline">
          {body}
        </Link>
      ) : (
        body
      )}
    </td>
  );
}

function SubtotalRow<R>({
  node,
  columns,
  depth,
  label,
}: {
  node: GroupNode<R>;
  columns: ReportColumn<R>[];
  depth: number;
  label: string;
}) {
  return (
    <tr className="bg-ppp-charcoal-50/70 border-t border-ppp-charcoal-100">
      <td
        className="px-3 py-1.5 text-[11.5px] font-bold text-ppp-charcoal-600 whitespace-nowrap"
        style={{ paddingLeft: `${12 + depth * 14}px` }}
      >
        {label}
      </td>
      {columns.slice(1).map((c) => (
        <td
          key={c.key}
          className={`px-3 py-1.5 text-[12px] font-bold tabular-nums ${isNumeric(c) ? "text-right" : ""} ${
            c.secondary ? "hidden sm:table-cell" : ""
          }`}
        >
          {c.amount ? fmt(c.kind, node.subtotals[c.key] ?? 0) : ""}
        </td>
      ))}
    </tr>
  );
}

function GroupRows<R>({
  nodes,
  columns,
  depth,
  showDetail,
  showSubtotals,
  showCounts,
}: {
  nodes: GroupNode<R>[];
  columns: ReportColumn<R>[];
  depth: number;
  showDetail: boolean;
  showSubtotals: boolean;
  showCounts: boolean;
}) {
  return (
    <>
      {nodes.map((node) => (
        <GroupBlock
          key={`${depth}-${node.label}`}
          node={node}
          columns={columns}
          depth={depth}
          showDetail={showDetail}
          showSubtotals={showSubtotals}
          showCounts={showCounts}
        />
      ))}
    </>
  );
}

function GroupBlock<R>({
  node,
  columns,
  depth,
  showDetail,
  showSubtotals,
  showCounts,
}: {
  node: GroupNode<R>;
  columns: ReportColumn<R>[];
  depth: number;
  showDetail: boolean;
  showSubtotals: boolean;
  showCounts: boolean;
}) {
  const hasChildren = node.children.length > 0;
  return (
    <>
      <tr className={depth === 0 ? "bg-surface border-t-2 border-ppp-charcoal-200" : "bg-surface border-t border-ppp-charcoal-100"}>
        <td
          colSpan={columns.length}
          className="px-3 py-2 text-[12.5px] font-bold text-ppp-charcoal"
          style={{ paddingLeft: `${12 + depth * 14}px` }}
        >
          {node.label}
          {showCounts && <span className="ml-1.5 font-semibold text-ppp-charcoal-400">({node.count})</span>}
        </td>
      </tr>

      {hasChildren ? (
        <GroupRows
          nodes={node.children}
          columns={columns}
          depth={depth + 1}
          showDetail={showDetail}
          showSubtotals={showSubtotals}
          showCounts={showCounts}
        />
      ) : (
        showDetail &&
        node.rows.map((row, i) => (
          <tr key={i} className="border-t border-ppp-charcoal-50 hover:bg-ppp-charcoal-50/40">
            {columns.map((c) => (
              <Cell key={c.key} col={c} row={row} />
            ))}
          </tr>
        ))
      )}

      {showSubtotals && <SubtotalRow node={node} columns={columns} depth={depth} label="Subtotal" />}
    </>
  );
}

export type GroupedReportProps<R> = {
  spec: ReportSpec<R>;
  rows: R[];
  /** Which of `spec.groupings` is active — the view switcher's value. */
  groupingIndex?: number;
  /** Rendered under the totals strip: date pickers, vendor filters, the switcher. */
  controls?: React.ReactNode;
  /** Shown when there are no rows at all. */
  emptyHint?: string;
  showDetail?: boolean;
  showSubtotals?: boolean;
  showCounts?: boolean;
  showGrandTotal?: boolean;
};

export function GroupedReport<R>({
  spec,
  rows,
  groupingIndex = 0,
  controls,
  emptyHint,
  showDetail = true,
  showSubtotals = true,
  showCounts = true,
  showGrandTotal = true,
}: GroupedReportProps<R>) {
  const groupings: ReportGrouping<R>[] = spec.groupings[groupingIndex] ?? spec.groupings[0] ?? [];
  const tree = buildGroups(rows, groupings, spec.columns);
  const totals = grandTotals(rows, spec.columns);

  return (
    <div className="space-y-4">
      {/* Totals strip — Salesforce puts these above everything, and they are
          the first thing anyone checks against their own spreadsheet. */}
      <section className="bg-surface border border-ppp-charcoal-100 rounded-xl px-4 py-3">
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          <div>
            <div className="text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400">Total records</div>
            <div className="font-condensed text-xl font-black text-ppp-charcoal tabular-nums leading-tight">
              {rows.length.toLocaleString()}
            </div>
          </div>
          {spec.totals.map((t) => (
            <div key={t.label}>
              <div className="text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400">{t.label}</div>
              <div className="font-condensed text-xl font-black text-ppp-charcoal tabular-nums leading-tight">
                {fmt(t.kind ?? "money", t.value(rows))}
              </div>
            </div>
          ))}
        </div>
        {controls && <div className="mt-3 pt-3 border-t border-ppp-charcoal-100">{controls}</div>}
      </section>

      {rows.length === 0 ? (
        <div className="text-center py-14 px-4 bg-surface border border-ppp-charcoal-100 rounded-xl">
          <p className="text-sm font-semibold text-ppp-charcoal">No records</p>
          {emptyHint && <p className="text-[12px] text-ppp-charcoal-500 mt-1 max-w-sm mx-auto">{emptyHint}</p>}
        </div>
      ) : (
        <section className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
          {/* The table scrolls sideways in its own box. The PAGE never does. */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse">
              <thead>
                <tr className="bg-ppp-charcoal-50 border-b border-ppp-charcoal-100">
                  {spec.columns.map((c) => (
                    <th
                      key={c.key}
                      scope="col"
                      className={`px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500 ${
                        isNumeric(c) ? "text-right" : "text-left"
                      } ${c.secondary ? "hidden sm:table-cell" : ""}`}
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <GroupRows
                  nodes={tree}
                  columns={spec.columns}
                  depth={0}
                  showDetail={showDetail}
                  showSubtotals={showSubtotals}
                  showCounts={showCounts}
                />
                {showGrandTotal && (
                  <tr className="bg-ppp-charcoal-100/80 border-t-2 border-ppp-charcoal-300">
                    <td className="px-3 py-2 text-[12px] font-black text-ppp-charcoal whitespace-nowrap">
                      Total{showCounts ? ` (${rows.length})` : ""}
                    </td>
                    {spec.columns.slice(1).map((c) => (
                      <td
                        key={c.key}
                        className={`px-3 py-2 text-[12.5px] font-black tabular-nums ${isNumeric(c) ? "text-right" : ""} ${
                          c.secondary ? "hidden sm:table-cell" : ""
                        }`}
                      >
                        {c.amount ? fmt(c.kind, totals[c.key] ?? 0) : ""}
                      </td>
                    ))}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
