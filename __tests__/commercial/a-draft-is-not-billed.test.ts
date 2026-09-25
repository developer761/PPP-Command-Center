import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { receivableVerdict } from "@/lib/commercial/reports/receivables";

/**
 * A DRAFT IS NOT BILLED, AND A VOID IS NOT OWED.
 *
 * Found on production on 2026-09-25: the Scheduling report showed
 * LMJ- Galil Brands -21 Newton Place at $94,000 owed on a $75,000 contract,
 * while the job page, the AR sheet and the job's own invoice panel all said
 * $19k. The $75,000 was a DRAFT invoice nobody has sent.
 *
 * A sweep of all 74 invoice-money call sites found the same shape in five more
 * places. Every one of them re-derived instead of asking `receivableVerdict`,
 * which has been the written rule, with its reasons, the whole time.
 *
 * WHY IT KEEPS HAPPENING, and why a filter is mandatory rather than
 * belt-and-braces: `balance_cents` is a STORED GENERATED COLUMN
 * (subtotal + tax − paid, migration 042). Voiding an invoice does NOT zero it.
 * A void row therefore sits in the table with a live-looking balance forever,
 * and any reader that trusts the row is wrong by that amount until somebody
 * notices — which, on a report of jobs owing money, is exactly the row nobody
 * questions.
 *
 * Source assertions: reconciling the real figures needs a database and this
 * suite deliberately has none. What was missing at each site was the
 * CONSULTATION, not the arithmetic, so the consultation is what is pinned.
 * Each proven to fail by reverting the site it names.
 */

const ROOT = process.cwd();
const read = (p: string) =>
  readFileSync(join(ROOT, p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the rule itself", () => {
  it("skips a void, never bills a draft, counts everything else", () => {
    expect(receivableVerdict("void")).toBe("skip");
    expect(receivableVerdict("draft")).toBe("uninvoiced");
    for (const s of ["sent", "partial", "paid", "overdue"] as const) {
      expect(receivableVerdict(s)).toBe("invoice");
    }
  });
});

/**
 * Each entry: the module, and what it would say wrongly without the rule.
 * Named one by one rather than inferred, so adding a money surface is a
 * decision somebody makes rather than a gap nobody notices.
 */
const SITES: { file: string; says: string }[] = [
  {
    file: "lib/commercial/reports/tomco/opportunities.ts",
    says: "Scheduling and Open Sales — balance owed, and the report's grand total",
  },
  {
    file: "lib/commercial/reports/tomco/balance-owed.ts",
    says: "the Balance Owed tab and its export — customer charges, payments in, balance owed",
  },
  {
    file: "lib/commercial/assistant/tools.ts",
    says: "the assistant's answer about one job: Billed · Collected · Outstanding",
  },
  {
    file: "app/commercial/opportunities/[id]/page.tsx",
    says: "the deal's attention strip and its billing sparkline",
  },
];

describe("every money surface asks the rule", () => {
  it("is checking a real list", () => {
    expect(SITES.length).toBeGreaterThanOrEqual(4);
  });

  for (const { file, says } of SITES) {
    it(`${file} — ${says}`, () => {
      expect(read(file)).toContain("receivableVerdict");
    });
  }
});

describe("the fixes select the column they branch on", () => {
  /**
   * The silent half of this bug. Asking a verdict about a `status` the query
   * never fetched gets `undefined` — which is not "void" and not "draft", so
   * every invoice comes back billable and the guard reads as if it works.
   */
  const NEEDS_STATUS = [
    "lib/commercial/reports/tomco/opportunities.ts",
    "lib/commercial/reports/tomco/balance-owed.ts",
    "lib/commercial/assistant/tools.ts",
  ];

  for (const file of NEEDS_STATUS) {
    it(`${file} selects status from commercial_invoices`, () => {
      const src = read(file);
      const selects = [
        ...src.matchAll(/from\("commercial_invoices"\)\s*\.?\s*\n?\s*\.select\("([^"]+)"/g),
      ].map((m) => m[1]);
      expect(selects.length, `no commercial_invoices select found in ${file}`).toBeGreaterThan(0);
      for (const sel of selects) {
        expect(sel, `${file} branches on status but does not select it`).toMatch(/\bstatus\b/);
      }
    });
  }
});

describe("the account hover card counts billed the way the rollup does", () => {
  const src = read("app/api/commercial/account-summary/[id]/route.ts");

  it("excludes draft as well as void", () => {
    // Void was excluded and draft was not, so the card overstated "$X billed"
    // against the Account 360 tile beside it, which uses the shared rollup.
    expect(src).toMatch(/\.not\("status", "in", "\(void,draft\)"\)/);
    expect(src).not.toMatch(/\.neq\("status", "void"\)/);
  });
});

/**
 * The deal page had three separate readings of the same table. All three are
 * named, because fixing two of three is how this class survived the last
 * sweep.
 */
describe("the deal page's three readings", () => {
  const src = read("app/commercial/opportunities/[id]/page.tsx");

  it("moneyClear ignores a void's stored balance", () => {
    // One void pinned a finished job on "Chase the last payment" forever and
    // withheld "Mark it completed" with it.
    expect(src).toMatch(/moneyClear[\s\S]{0,260}receivableVerdict/);
  });

  it("the billing sparkline filters on status, not only on a date", () => {
    // `issued_at` is never cleared on un-send and the DAG allows sent → draft,
    // so a date is not evidence that an invoice is live.
    expect(src).toMatch(/receivableVerdict[\s\S]{0,200}etDateOf\(inv\.issued_at\)/);
  });

  it("oldestUnpaid does not date the chase-up from an invoice nobody owes", () => {
    expect(src).toMatch(/oldestUnpaid[\s\S]{0,260}receivableVerdict/);
  });
});
