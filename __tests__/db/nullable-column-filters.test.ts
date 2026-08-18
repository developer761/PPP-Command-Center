import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guard for the worst bug this codebase has shipped.
 *
 * `customer_form_tokens.kind` is nullable with no default, and EVERY real
 * customer invite is written with `kind: null`. PostgREST turns `.neq("kind",
 * "preview")` into `kind <> 'preview'`, which evaluates to NULL — not TRUE —
 * for a NULL row. So a filter meant to exclude ~37 preview tokens silently
 * excluded 35 real customer forms as well.
 *
 * Measured against production before the fix:
 *   .neq("kind","preview")            → 18 rows
 *   .or("kind.is.null,kind.neq.preview") → 53 rows
 *
 * The visible effect was that after sending a colour form the work-order page
 * still said "not sent", the progress bar never advanced, and Send Reminder
 * never appeared. It survived three review rounds because internal-entry
 * tokens (kind='internal') DO have a value and behaved correctly — so every
 * "the progress bar is stuck" report happened to be on a work order that
 * looked fine.
 *
 * This is a SQL semantics trap, not a typo: any `.neq()` on a nullable column
 * silently drops the NULL rows. Filter in JS, or use the
 * `.or("<col>.is.null,<col>.neq.<value>")` form.
 */

const NULLABLE_COLUMNS = ["kind"];

/** Strip comments before scanning. The first version of this guard flagged the
 *  very comment that documents the bug — a source-level check that can't tell
 *  code from prose reports the fix as the defect. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const FILES = [
  "lib/materials-page-data.ts",
  "lib/wo-progress/derive.ts",
  "app/api/admin/sent/route.ts",
  "lib/customer-form/tokens.ts",
];

describe("no .neq() against a nullable column", () => {
  it.each(FILES)("%s", (rel) => {
    const src = codeOnly(readFileSync(join(process.cwd(), rel), "utf8"));
    for (const col of NULLABLE_COLUMNS) {
      const bad = new RegExp(`\\.neq\\(\\s*["'\`]${col}["'\`]`, "g");
      const hits = src.match(bad) ?? [];
      expect(
        hits.length,
        `${rel} filters a NULLABLE column with .neq("${col}", …). ` +
          `SQL evaluates NULL <> 'x' as NULL, so every row with a null ${col} ` +
          `is silently dropped. Filter in JS, or use ` +
          `.or("${col}.is.null,${col}.neq.<value>").`
      ).toBe(0);
    }
  });

  it("the loader that feeds the materials pages still excludes previews in JS", () => {
    const src = readFileSync(join(process.cwd(), "lib/materials-page-data.ts"), "utf8");
    expect(
      /kind === "preview"/.test(src),
      "removing the DB filter is only safe while the JS guard exists — it doesn't"
    ).toBe(true);
  });
});
