import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every money report counts AIA billing, including the two that live in
 * lib/commercial/reports/tomco/opportunities.ts.
 *
 * Tomco's largest GCs are billed through G702/G703 applications, not invoices.
 * That module built its money purely from `commercial_invoices`, so Open Sales
 * — whose blurb promises "what has been billed and what is in" — opened with
 * the four biggest live jobs on the report all reading zero:
 *
 *     AIREF Building #2   contract $404,836.00   billed $0.00   owed $0.00
 *     AIREF Building #1            $283,082.00          $0.00        $0.00
 *     AIREF Building #3            $256,624.50          $0.00        $0.00
 *     AIREF Building #4            $256,624.50          $0.00        $0.00
 *
 * $1.2M of live contract shown as never billed, while the AIA tool holds three
 * submitted applications against #1 alone and the job-costs report puts #2 at
 * $272,448.21 billed — two reports, one job, $272k apart. The Scheduling
 * report, built from the same rows, said $0.00 owed on all four.
 *
 * This was not a decision anyone made. ar-aging, cash-flow, jobs, receivables
 * and transactions were all folded into AIA months ago; this module was missed,
 * and nothing failed when it was.
 *
 * ── WHY A SOURCE TEST ──────────────────────────────────────────────────────
 *
 * Reconciling the real figures needs a database, and the unit suite
 * deliberately has none. What can be held here is the SEAM: that the module
 * still consults the AIA rollup at all. That is precisely what was missing —
 * the arithmetic was never wrong, the data source was absent — so it is the
 * right thing to pin. Proven to fail by removing the rollup call.
 */

const ROOT = process.cwd();
const MODULE = "lib/commercial/reports/tomco/opportunities.ts";

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const src = stripComments(readFileSync(join(ROOT, MODULE), "utf8"));

describe("the deal report rows include AIA money", () => {
  it("asks for the AIA rollup", () => {
    expect(
      src.includes("aiaBillingRollupBulk"),
      `${MODULE} builds Open Sales and Scheduling; without the AIA rollup both read $0 billed on every G702-billed job`,
    ).toBe(true);
  });

  it("adds AIA into billed, owed and paid rather than replacing them", () => {
    // A job can in principle carry both an invoice and an application; picking
    // one source would silently drop the other.
    expect(src).toMatch(/billedCents:\s*m\.sub\s*\+/);
    expect(src).toMatch(/balanceCents:\s*m\.bal\s*\+/);
    expect(src).toMatch(/paidCents:\s*m\.paid\s*\+/);
  });

  it("ages dueNowCents, not the retainage-inclusive figure", () => {
    // Retainage is held to close-out, not late. Counting it as owed would age
    // money nobody is wrongly withholding — the AR aging report's own rule.
    expect(src).toContain("dueNowCents");
    expect(
      /balanceCents:[^\n]*retainageHeldCents/.test(src),
      "retainage must not be counted as a balance owed",
    ).toBe(false);
  });

  it("uses the BULK rollup, not the per-opportunity one in a loop", () => {
    // aiaBillingRollup fans out to ~5 sequential queries each; this module
    // runs over every opportunity, so the singular form would put hundreds of
    // round-trips behind two reports.
    expect(/\baiaBillingRollup\s*\(/.test(src)).toBe(false);
  });
});

/**
 * The wider rule, so the next money report cannot quietly skip AIA: any
 * reports module that reads invoice balances should also know about AIA.
 * Listed explicitly rather than inferred, so adding a module is a decision.
 */
describe("every money report module knows about AIA", () => {
  const dir = join(ROOT, "lib/commercial/reports");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  it("scanned a real number of modules", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("names the modules already folded in, so a regression is visible", () => {
    const folded = files.filter((f) =>
      /\baia/i.test(stripComments(readFileSync(join(dir, f), "utf8"))),
    );
    // These five were done months before the tomco module was noticed. If one
    // ever loses its AIA handling this goes red and names it.
    for (const expected of [
      "ar-aging.ts",
      "cash-flow.ts",
      "jobs.ts",
      "receivables.ts",
      "transactions.ts",
    ]) {
      expect(folded, `${expected} no longer counts AIA money`).toContain(expected);
    }
  });
});

/**
 * The Ask assistant counts AIA too.
 *
 * Asked "what's the balance on AIREF Building #2?" on 2026-09-25 it replied:
 * "Contract $404,836.00, nothing billed yet, so nothing outstanding." The job
 * had $272,448.21 certified and $86,695.10 owed. The COSTS in the same reply
 * were right to the cent, which is exactly what made it convincing.
 *
 * A wrong tile gets cross-checked against the page beside it. A sentence does
 * not. And "How much are we owed?" is one of the panel's own suggested
 * questions, answered from invoices alone on a book whose largest GCs bill by
 * certificate.
 */
describe("the assistant's money tools count AIA", () => {
  const src = stripComments(
    readFileSync(join(ROOT, "lib/commercial/assistant/tools.ts"), "utf8"),
  );

  it("asks for the AIA rollup", () => {
    expect(src).toContain("aiaBillingRollupBulk");
  });

  it("adds AIA into a job's billed, collected and owed", () => {
    expect(src).toMatch(/billed[\s\S]{0,120}aia\?\.billedCents/);
    expect(src).toMatch(/paid[\s\S]{0,120}aia\?\.collectedCents/);
    expect(src).toMatch(/owed[\s\S]{0,120}aia\?\.dueNowCents/);
  });

  it("adds AIA into the whole-book outstanding total", () => {
    expect(src).toContain("aiaOwed");
    expect(src).toContain("aiaCollected");
  });

  it("ages dueNowCents, never the retainage-inclusive figure", () => {
    expect(/owed[^\n]*retainageHeldCents/.test(src)).toBe(false);
  });
});
