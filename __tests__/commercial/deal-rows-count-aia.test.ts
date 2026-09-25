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
 * A DRAFT IS NOT BILLED, AND A VOID IS NOT OWED — in this module too.
 *
 * The same file summed `balance_cents` across every live invoice whatever its
 * status. On LMJ- Galil Brands -21 Newton Place that put a DRAFT invoice of
 * $75,000 into "balance owed" on a $75,000 contract, so Scheduling showed
 * $94,000 owed — the draft plus $19,000 genuinely due through AIA — while the
 * job page, the AR sheet and the invoice panel all said $19k. Owed came out
 * larger than the whole contract, on the report Brendan reads down to decide
 * who to chase. The Bannett Group read $71,250 owed on a $37,500 contract for
 * the same reason, and every draft in the book was inflating the grand total.
 *
 * The rule was already written down, one directory away, with its reasons:
 * void is money nobody owes; a draft is owed but NOT BILLED, so it is listed
 * as uninvoiced and never aged. This module re-derived instead of asking —
 * the identical mistake found in the assistant's money tools the same day.
 *
 * Pinned as source because reconciling the real figures needs a database and
 * this suite has none. What was missing was the CONSULTATION, not the
 * arithmetic, so that is what is held. Proven to fail by deleting the guard.
 */
describe("the deal report rows respect invoice status", () => {
  it("asks receivableVerdict rather than trusting every balance", () => {
    expect(
      src.includes("receivableVerdict"),
      `${MODULE} feeds Scheduling and Open Sales; without this a draft counts as owed`,
    ).toBe(true);
  });

  it("selects the column the verdict needs", () => {
    // Asking for a status it never fetched is the silent half of this bug:
    // `status` comes back undefined and every invoice looks like the default.
    expect(src).toMatch(/\.select\("opportunity_id, status,/);
  });

  it("drops a void entirely and counts a draft as neither billed nor owed", () => {
    expect(src).toMatch(/verdict === "skip"[\s\S]{0,80}continue/);
    expect(src).toMatch(/verdict === "uninvoiced"[\s\S]{0,140}continue/);
  });

  it("still adds AIA on top, which is the other half of the same row", () => {
    // The two fixes touch the same four lines; this catches one being undone
    // while the other is edited.
    expect(src).toMatch(/balanceCents:\s*m\.bal\s*\+/);
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

  /**
   * The first cut of this fix added AIA to the outstanding TOTAL and left the
   * past-due line on invoices alone — so one sentence carried two figures from
   * two different books: "$799,323.63 outstanding, of which $171,067.92 is
   * past due". A partial guard, in the commit that was fixing partial guards.
   */
  it("counts AIA in PAST DUE, not just in the total", () => {
    expect(src).toContain("aiaLateCents");
    expect(src).toContain("aiaDueAtFrom");
  });

  /**
   * Void and draft are decided ONCE, in receivableVerdict, which records why:
   * void is money nobody owes; a draft is owed but not billed, so it is listed
   * and never aged. The assistant filtered on `balance_cents > 0` alone, so a
   * void with a balance would have counted as owed and a draft with a due date
   * would have counted as late. Neither is true in the database today, which
   * is exactly what makes it worth pinning — a latent wrong answer waits for
   * one row.
   */
  it("asks receivableVerdict rather than re-deriving void/draft", () => {
    expect(src).toContain("receivableVerdict");
    expect(
      /const open = invoices\.filter\(\(i\) => Number\(i\.balance_cents\) > 0\)/.test(src),
      "filtering on a balance alone re-creates the void-counts-as-owed bug",
    ).toBe(false);
  });

  it("never ages a draft", () => {
    expect(src).toMatch(/verdict === "invoice"/);
  });

  it("uses the same lateness ladder AR aging uses", () => {
    // An application must be late here on the day it is late there.
    const aging = stripComments(
      readFileSync(join(ROOT, "lib/commercial/reports/ar-aging.ts"), "utf8"),
    );
    expect(aging).toContain("aiaDueAtFrom");
    expect(src).toContain("aiaDueAtFrom");
  });
});
