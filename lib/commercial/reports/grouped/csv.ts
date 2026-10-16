import { csvEscape } from "@/lib/commercial/csv";
import { buildGroups, grandTotals, type ReportSpec } from "@/lib/commercial/reports/grouped/spec";

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

  /**
   * MONEY GOES OUT AS A PLAIN NUMBER, NOT AS CURRENCY.
   *
   * It used to be `formatCentsFull`, which yields `-$114.69`. That is not a
   * plain number, so `csvEscape`'s formula-injection guard prefixes it with an
   * apostrophe, and Excel reads every negative as TEXT and skips it in a SUM.
   *
   * Measured on the Purchases report: Excel's own `=SUM()` over the Amount
   * column returns $578,710.30 while the file's printed TOTAL says
   * $575,898.45 — the 16 credits are silently missing, a $2,811.85 error in a
   * file that goes to an accountant and looks perfectly fine.
   *
   * `transactions-export.ts` and `receivables-export.ts` have always emitted
   * `(cents / 100).toFixed(2)` for exactly this reason. This is the one
   * builder that did not, and the guard's own docblock describes this failure
   * as the thing it was carefully written NOT to cause.
   *
   * The money formatting belongs on the page, which still has it; a CSV cell
   * is data, and the spreadsheet formats it.
   */
  const cell = (kind: string | undefined, n: number): string =>
    kind === "money"
      ? (Math.round(n) / 100).toFixed(2)
      : `${Math.round(n * 100) / 100}`;

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

  /*
   * CRLF, like every other export — and like the title block that is prepended
   * to this one. It used to be "\n", so each of the five Accounting sheets
   * opened with two CRLF lines and then switched to LF for the rest of the
   * file: one document, two line endings, which is exactly what makes a
   * hand-rolled splitter downstream keep a stray "\r" on some rows only.
   */
  return out.join("\r\n") + "\r\n";
}
