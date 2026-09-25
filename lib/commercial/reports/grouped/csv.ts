import { csvEscape } from "@/lib/commercial/csv";
import { buildGroups, grandTotals, type ReportSpec } from "@/lib/commercial/reports/grouped/spec";
import { formatCentsFull } from "@/lib/commercial/invoices/format";

/**
 * A grouped report as the CSV Mary sends on.
 *
 * Built from the SAME spec the page renders, so the file and the screen cannot
 * disagree — same columns, same order, same groups, same subtotals, same grand
 * total. That is the whole point: if the export did not tie out with the page,
 * she would keep the spreadsheet and we would have built nothing.
 */
export function groupedReportCsv<R>(
  spec: ReportSpec<R>,
  rows: R[],
  groupingIndex = 0
): string {
  const groupings = spec.groupings[groupingIndex] ?? spec.groupings[0] ?? [];
  const tree = buildGroups(rows, groupings, spec.columns);
  const totals = grandTotals(rows, spec.columns);

  const cell = (kind: string | undefined, n: number): string =>
    kind === "money" ? formatCentsFull(n) : kind === "hours" ? `${Math.round(n * 100) / 100}` : `${Math.round(n * 100) / 100}`;

  const out: string[] = [];
  // The totals strip, so the figure at the top of the page is the figure at the
  // top of the file.
  out.push([csvEscape("Total records"), csvEscape(rows.length)].join(","));
  for (const t of spec.totals) {
    out.push([csvEscape(t.label), csvEscape(cell(t.kind ?? "money", t.value(rows)))].join(","));
  }
  out.push("");

  const header = ["Group", ...spec.columns.map((c) => c.label)];
  out.push(header.map(csvEscape).join(","));

  const emit = (nodes: ReturnType<typeof buildGroups<R>>, path: string[]) => {
    for (const node of nodes) {
      const here = [...path, node.label];
      if (node.children.length > 0) {
        emit(node.children, here);
      } else {
        for (const row of node.rows) {
          out.push(
            [
              csvEscape(here.join(" › ")),
              ...spec.columns.map((c) => {
                // csvText wins where the on-screen word only means something
                // as a link — "View" in a spreadsheet cell is an instruction
                // to click something that isn't there.
                const t = c.csvText ?? c.text;
                return csvEscape(t ? t(row) ?? "" : c.amount ? cell(c.kind, c.amount(row)) : "");
              }),
            ].join(",")
          );
        }
      }
      // The subtotal line, labelled with the group it belongs to — a bare
      // "Subtotal" in a flat file is unreadable once it is out of the page.
      out.push(
        [
          csvEscape(`${here.join(" › ")} — subtotal (${node.count})`),
          ...spec.columns.map((c, i) =>
            csvEscape(c.amount ? cell(c.kind, node.subtotals[c.key] ?? 0) : i === 0 ? "" : "")
          ),
        ].join(",")
      );
    }
  };
  emit(tree, []);

  out.push(
    [
      csvEscape(`TOTAL (${rows.length})`),
      ...spec.columns.map((c) => csvEscape(c.amount ? cell(c.kind, totals[c.key] ?? 0) : "")),
    ].join(",")
  );

  return out.join("\n");
}
