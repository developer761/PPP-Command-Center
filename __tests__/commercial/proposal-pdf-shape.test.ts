import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * WHY THIS FILE EXISTS.
 *
 * Karan, 2026-08-21: "These bugs on the platform shouldn't have occurred after
 * all our testing."
 *
 * He is right, and the reason is specific: 1274 tests all check LOGIC. Not one
 * of them looks at a generated document. So every proposal-PDF defect
 * Stephanie found — sections in the wrong order, the estimator block printed
 * twice, a price that ignored its own checkbox — was invisible to the suite
 * while being the first thing a human noticed.
 *
 * Rendering react-pdf to bytes and reading the text back is not practical in
 * node, so this asserts the SHAPE of the document instead: which section
 * components appear in the customer document, and in what order. That is
 * exactly the class of thing that broke, and it is cheap to check.
 */

const SRC = readFileSync("lib/commercial/proposals/pdf.tsx", "utf8");

/** The customer document body — from the intro to the page footer. */
function customerBody(): string {
  const start = SRC.indexOf("{mode !== \"internal\" && <Text style={styles.intro}>");
  const end = SRC.indexOf("Footer fixed to bottom of every page", start);
  expect(start, "intro paragraph not found — did the document get restructured?").toBeGreaterThan(0);
  expect(end, "footer marker not found").toBeGreaterThan(start);
  return SRC.slice(start, end);
}

function orderOf(body: string, needles: string[]): number[] {
  return needles.map((n) => {
    const i = body.indexOf(n);
    expect(i, `"${n}" is not in the customer document at all`).toBeGreaterThan(-1);
    return i;
  });
}

describe("customer proposal — section order Stephanie asked for twice", () => {
  // 8/17: "Total price goes after scope/inclusions · Alternate goes after
  // total price · Then Exclusions". 8/20: "Total price goes before
  // exclusions, not after."
  it("runs Inclusions → TOTAL → Add Alternate → Exclusions", () => {
    const body = customerBody();
    const [inclusions, total, alternates, exclusions] = orderOf(body, [
      "<InclusionsCustomer",
      "<TotalRow",
      "<AlternateSectionCustomer",
      "<ExclusionsBlock",
    ]);
    expect(inclusions, "Inclusions must come first").toBeLessThan(total);
    expect(total, "TOTAL must come before the alternates").toBeLessThan(alternates);
    expect(alternates, "Alternates must come before Exclusions").toBeLessThan(exclusions);
  });

  it("prints the estimator's details exactly once", () => {
    // The sign-off carries name/title/phone/email now. Rendering the old
    // standalone EstimatorBlock alongside it repeated all four on one page,
    // which is what "the sign off still kind of lame looking" was describing.
    const body = customerBody();
    expect(
      (body.match(/<EstimatorBlock/g) ?? []).length,
      "EstimatorBlock should appear once, on the branch with no sign-off"
    ).toBe(1);
    // The RULE is that the two blocks are mutually exclusive — one ternary,
    // SignatureBlock on one branch and EstimatorBlock on the other. Asserted by
    // shape, not by the name of the variable steering it: this used to pin
    // `showSignatureBlock ? (` and broke when that became `signOff` (the sign-
    // off now defaults on for customer copies, per Stephanie 2026-09-01),
    // while a change that rendered BOTH would have sailed past it.
    expect(
      (body.match(/<SignatureBlock/g) ?? []).length,
      "SignatureBlock should appear once, on the branch with no estimator block"
    ).toBe(1);
    expect(
      body,
      "the two blocks must be the two arms of ONE ternary, never both"
    ).toMatch(/\?\s*\(\s*\n?\s*<SignatureBlock[\s\S]*?\)\s*:\s*\(\s*\n?\s*<EstimatorBlock/);
  });

  it("no longer restates the alternates total under the alternates", () => {
    // "the bullet is coming first with the price and then the verbiage for the
    // alternate and then the total price shows up again."
    expect(SRC).not.toContain("ADD ALTERNATE:");
  });
});

describe("one word for the scope section, across every generated document", () => {
  // Stephanie 2026-08-20: "Inclusions, scope of work, change all PDF's to read
  // one or the other." Tomco's own Work Order says "Inclusions".
  const DOCS = [
    "lib/commercial/proposals/pdf.tsx",
    "lib/commercial/work-orders/pdf.tsx",
  ];

  it("every document heads the section 'Inclusions', never 'Scope of Work'", () => {
    for (const f of DOCS) {
      const src = readFileSync(f, "utf8");
      // Headings only — prose in comments may still explain the old name.
      const headings = src.match(/<Text style={styles\.(h2|sectionUnderlineHeader)}>([^<]+)<\/Text>/g) ?? [];
      const offending = headings.filter((h) => /Scope of Work/i.test(h));
      expect(offending, `${f} still heads a section "Scope of Work"`).toEqual([]);
    }
  });
});
