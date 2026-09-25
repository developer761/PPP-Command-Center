import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A SECOND DOOR ONTO A GATED SCREEN NEEDS THE SAME LOCK.
 *
 * Accounting is admin-or-account-manager. Three other things read the same
 * data and asked a different question at the door — "may this login use the
 * commercial platform", which every sales rep passes:
 *
 *   1. The assistant. It answers in prose from the same database the pages
 *      read: the whole book's outstanding and past due, the AR sheet Mary
 *      sends Alex, the purchase register, a job's billed/collected/cost by
 *      category. Its own docblock said it was "behind the same access check as
 *      every commercial page — it can read the company's money, so it is not
 *      open to anyone with the URL". The comment read as a decision; the check
 *      under it answered something else. And a figure in a sentence is not
 *      cross-checked the way a figure in a tile is.
 *
 *   2. The Accounting export. One guard covered five sheets and asked for the
 *      RECEIVABLES report folder — for Purchases by vendor, crew payouts and
 *      the partner deposit history. A rep in a folder holding only Receivables
 *      could pull all three by changing ?view=.
 *
 *   3. The deposited tick (pinned in finance-api-gate.test.ts).
 *
 * These are source assertions because the alternative needs a database and a
 * live model. What was missing in each case was the CHECK, not the arithmetic
 * — so the check is the right thing to pin. Each proven to fail by reverting
 * the line it names.
 */

const ROOT = process.cwd();
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const read = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"));
const body = (p: string) => read(p).replace(/^import[\s\S]*?;$/gm, "");

describe("the assistant cannot read money to a rep", () => {
  const ask = read("lib/commercial/assistant/ask.ts");
  const route = body("app/api/commercial/assistant/route.ts");

  it("names the money lookups", () => {
    expect(ask).toContain("MONEY_TOOLS");
    // The four that return what requireFinanceViewer guards. open_bids and
    // crew_hours are deliberately NOT here — bid values are on the rep's own
    // pipeline and hours are not pay.
    for (const t of ["job_summary", "money_overview", "vendor_spend", "ar_sheet"]) {
      expect(
        new RegExp(`MONEY_TOOLS[^\\n]*${t}`).test(ask),
        `${t} returns figures only Accounting shows`,
      ).toBe(true);
    }
  });

  it("withholds them from the tool list", () => {
    expect(ask).toMatch(/tools:\s*canSeeMoney \? TOOLS : TOOLS\.filter/);
  });

  /**
   * A filtered tool list is a PROMPT-level control. The data is not. If a
   * money tool is ever reachable — a new caller, a cached tool list, a model
   * that names one anyway — the runner has to refuse it on its own.
   */
  it("refuses them in the runner too, not only in the list", () => {
    expect(ask).toMatch(/if \(!canSeeMoney && MONEY_TOOLS\.has\(name\)\)/);
  });

  it("defaults to withholding when a caller forgets the flag", () => {
    expect(
      /canSeeMoney = false/.test(ask),
      "the default has to be the safe answer, not the open one",
    ).toBe(true);
  });

  it("tells the model what it may not say, not just which tools it lacks", () => {
    // Without this it has no figure AND no explanation, so it guesses at a
    // reason or says nothing useful.
    expect(ask).toContain("WHAT THIS PERSON MAY NOT SEE");
  });

  it("the route decides from the role, with the admin-email fallback", () => {
    expect(route).toMatch(/role === "admin" \|\| role === "account_manager"/);
    expect(route).toContain("isAdminEmail");
    expect(route).toMatch(/askAssistant\(question, history, canSeeMoney\)/);
  });

  it("the finder still finds an invoice, without reading out its totals", () => {
    const tools = read("lib/commercial/assistant/tools.ts");
    expect(tools).toMatch(/findRecords\(query: string, canSeeMoney/);
    expect(tools).toMatch(/canSeeMoney\s*\?[\s\S]{0,400}INVOICE/);
  });
});

describe("each Accounting export sheet carries its own gate", () => {
  const src = read("app/api/commercial/accounting/export/route.ts");

  it("does not gate all five sheets on the receivables folder", () => {
    const guards = [...src.matchAll(/guard:\s*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(guards.length, "every sheet declares a guard").toBe(5);
    expect(
      guards.filter((g) => /report:\s*"receivables"/.test(g)).length,
      "only the two receivables sheets may ask for the receivables folder",
    ).toBe(2);
  });

  it("requires the Accounting roles for the three registers that are not receivables", () => {
    for (const key of ["purchases", '"labor-out"', "deposits"]) {
      const block = new RegExp(`${key}:\\s*\\{[\\s\\S]*?guard:\\s*\\{([^}]*)\\}`).exec(src);
      expect(block, `${key} has no guard`).not.toBe(null);
      expect(/accounting:\s*true/.test(block![1]), `${key} is not Accounting-gated`).toBe(true);
    }
  });

  it("declares labor payouts as per-person pay", () => {
    // Same role test as `accounting`, different reason — guardExport says in
    // as many words that a reader should not have to know they coincide.
    const block = /"labor-out":\s*\{[\s\S]*?guard:\s*\{([^}]*)\}/.exec(src);
    expect(/people:\s*true/.test(block![1])).toBe(true);
  });

  it("gates BEFORE it decides the view is unknown", () => {
    // Otherwise a bad ?view= returns 400 to anyone, which says whether a
    // sheet name exists without asking who is calling.
    const guardAt = src.indexOf("await guardExport");
    const notFoundAt = src.indexOf("Nothing to export for");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(notFoundAt);
  });

  it("falls back to the strictest gate for a view it does not know", () => {
    expect(src).toMatch(/guardExport\(sheet\?\.guard \?\? \{ accounting: true \}\)/);
  });
});

/**
 * And the receipt column links to the receipt.
 *
 * Not authorization, but found in the same pass and the same shape of defect:
 * the data was there and the surface did not use it. 55 receipts uploaded,
 * "Yes" in the Receipt column as dead text, and no way to open one from the
 * list they were uploaded into — while the download route existed, and gated
 * itself, the whole time.
 */
describe("an attached receipt can be opened", () => {
  const src = read("lib/commercial/reports/tomco/transactions.ts");

  it("carries the document id, not just whether there is one", () => {
    expect(src).toContain("receiptDocumentId");
    expect(src).toMatch(/receiptDocumentId:\s*p\.receipt_document_id/);
  });

  it("links the cell at the download route", () => {
    expect(src).toMatch(/\/api\/commercial\/documents\/\$\{r\.receiptDocumentId\}\/download/);
  });

  it("opens it in a new tab", () => {
    // Following it in place loses your position in a 116-row list you are
    // reading against paperwork.
    expect(src).toMatch(/newTab:\s*true/);
    const grouped = read("components/commercial/grouped-report.tsx");
    expect(grouped).toMatch(/col\.newTab/);
    expect(grouped).toMatch(/rel="noopener noreferrer"/);
  });

  it("still says Yes in the spreadsheet", () => {
    // "View" in a CSV cell is an instruction to click something that isn't
    // there.
    expect(src).toMatch(/csvText:\s*\(r\) => \(r\.hasReceipt \? "Yes"/);
    expect(read("lib/commercial/reports/grouped/csv.ts")).toMatch(/c\.csvText \?\? c\.text/);
  });
});
