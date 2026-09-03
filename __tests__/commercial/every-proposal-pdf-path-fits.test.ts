import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * EVERY path that renders a proposal PDF fits it to one page.
 *
 * Brendan 2026-09-03: "this splits into 2 pages."
 *
 * It did — in the EMAIL, and only there. Fit-to-one-page lived in the download
 * route and nowhere else, so Preview showed one page and the attachment the GC
 * actually received had two. The copy that matters was the copy skipping the
 * fit.
 *
 * Three sites render this PDF: the download route, the send path, and the
 * estimating-report filing. A seam test, because nothing in the type system
 * says they have to agree — each one calls `renderProposalPdf` directly and
 * compiles perfectly without the wrapper.
 *
 * The same reasoning already had a comment in the send path — "one resolver …
 * so the archived snapshot can't differ from what the customer saw" — about the
 * DATA. The layout needed saying out loud too.
 */
const SITES: Array<[string, string]> = [
  ["download route", "app/api/commercial/proposals/[proposalId]/pdf/route.ts"],
  ["send to the GC", "lib/commercial/proposals/db.ts"],
  ["estimating report", "app/commercial/accounts/[id]/deals/[dealId]/proposal/[proposalId]/page.tsx"],
];

describe("every proposal PDF goes through the fit", () => {
  for (const [label, file] of SITES) {
    const src = readFileSync(file, "utf8");

    it(`${label} still renders a proposal PDF (guards the check below)`, () => {
      // If the render moves out of this file, the assertion under it would pass
      // on a file that no longer does the thing.
      expect(src).toContain("renderProposalPdf");
    });

    it(`${label} fits it to one page`, () => {
      expect(
        /renderFitToOnePage\s*\(/.test(src),
        `${file} renders a proposal PDF without renderFitToOnePage — that copy will run to two pages while the others fit, which is exactly what sent a two-page attachment to a GC while Preview showed one.`
      ).toBe(true);
    });

    it(`${label} passes the scale INTO the render`, () => {
      // Calling the wrapper but ignoring its argument silently renders the same
      // page N times and returns the natural length — a check that passes while
      // the bug survives.
      expect(src).toMatch(/pageHeightScale/);
    });
  }
});

describe("the Compact checkbox tells the truth", () => {
  const src = readFileSync(
    "app/commercial/accounts/[id]/deals/[dealId]/proposal/[proposalId]/page.tsx", "utf8"
  );

  it("no longer claims it is what pulls a proposal onto one page", () => {
    // Brendan's "it does not add numbers to the pages like it's says it should"
    // came from this copy. Fitting is automatic now; Compact only changes the
    // starting density. Page numbers DO print on a document too long to fit —
    // verified by byte delta: 113 bytes of numbering appear on a 3-page render
    // and vanish when the render function is disabled.
    expect(src).not.toContain("to pull a slightly-long proposal back onto one page");
    expect(src).toContain("fitted onto one page automatically");
  });
});
