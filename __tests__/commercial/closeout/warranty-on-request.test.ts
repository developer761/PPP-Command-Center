import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Katie's rule, in one line: **"Warranty sent ONLY as requested."**
 *
 * The close-out send used to do the opposite. Marking a package "sent"
 * rendered the warranty letter and filed it, stamped "1-year warranty letter
 * sent", on every job — because `warranty_years` defaults to 1 and the send
 * checked only that it was above zero. Nobody had to ask.
 *
 * That is not a paperwork detail. The letter carries Brendan's stored
 * signature over a twelve-month guarantee to repair or replace at Tomco's own
 * expense. A warranty nobody requested is an obligation nobody had to give.
 *
 * The rule is easy to undo by accident — "the transmittal is filed on send,
 * why isn't the warranty?" is a reasonable-sounding thought. So it is pinned
 * here, where the reason is written down next to the assertion.
 */

const TOOL = join(
  process.cwd(),
  "app/commercial/accounts/[id]/closeout/[dealId]/closeout-tool.tsx"
);

/** The body of a top-level `async function <name>(` declaration.
 *  Bounded by the closing brace in column 0, so a following function's doc
 *  comment can't be read as part of this one. */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`async function ${name}(`);
  if (start === -1) return "";
  const rest = src.slice(start);
  const end = rest.indexOf("\n}\n");
  return end === -1 ? rest : rest.slice(0, end);
}

describe("the warranty letter goes out only when asked for", () => {
  const src = readFileSync(TOOL, "utf8");

  it("the close-out send files the transmittal and NOT the warranty", () => {
    const body = functionBody(src, "autoFileCloseoutPackage");
    expect(body).not.toBe("");
    expect(body).toContain("renderCloseoutTransmittalPdf");
    expect(body).not.toContain("renderWarrantyLetterPdf");
  });

  it("issuing it is its own action, and stamps when it happened", () => {
    const body = functionBody(src, "issueWarrantyAction");
    expect(body).not.toBe("");
    expect(body).toContain("renderWarrantyLetterPdf");
    // Stamped, so the record can answer "did we ever warrant this job, and
    // when" — the question that gets asked two years later.
    expect(body).toContain("markWarrantyIssued");
  });

  it("the letter is filed BEFORE the package is stamped as issued", () => {
    // The other order would let a failed render leave a package claiming a
    // warranty was issued with no document behind it.
    const body = functionBody(src, "issueWarrantyAction");
    expect(body.indexOf("autoFileOpportunityDocument")).toBeLessThan(
      body.indexOf("markWarrantyIssued")
    );
  });

  it("the warranty TERM is untouched by any of this", () => {
    // The warranty period is a fact about the job — it drives "warranty
    // through" on the deal and the close-out checklist — whether or not a
    // letter was ever requested. Gating the term would have been the wrong fix.
    const migration = readFileSync(
      join(process.cwd(), "supabase/migrations/158_closeout_warranty_issued_at.sql"),
      "utf8"
    );
    expect(migration).toContain("warranty_issued_at");
    expect(migration).not.toMatch(/ALTER COLUMN warranty_years/);
  });
});
