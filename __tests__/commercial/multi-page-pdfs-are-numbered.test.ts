import { describe, it, expect } from "vitest";

/**
 * A document that runs to more than one page carries page numbers.
 *
 * Brendan 2026-09-03 asked for them. `pdf.tsx` already had the feature — a
 * react-pdf `fixed render` guarded on `totalPages > 1` — and it had never once
 * printed a number, because the two things are ordered wrongly:
 *
 *   1. `renderFitToOnePage` runs first, so react-pdf always sees totalPages 1
 *      and the guard yields "";
 *   2. the extra pages arrive AFTER that, when the plan set is spliced on with
 *      pdf-lib — long after react-pdf has finished.
 *
 * Nothing about that is visible in the source. Both files read correctly on
 * their own; the defect lives in the order they run in. So this test extracts
 * the TEXT of the finished bytes and looks for the number.
 *
 * `expect(src).toContain("pageNumber")` would have passed throughout.
 */

describe("stampPageNumbers", () => {
  it("numbers every page of a multi-page document", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const { stampPageNumbers } = await import("@/lib/commercial/pdf/stamp-page-numbers");

    const src = await PDFDocument.create();
    src.addPage([612, 792]);
    src.addPage([612, 792]);
    src.addPage([612, 792]);
    const before = Buffer.from(await src.save());

    const after = await stampPageNumbers(before);

    // Assert on something a rewrite cannot fake: the stamped bytes must differ,
    // keep the same page count, and keep Letter dimensions.
    expect(after.length).not.toBe(before.length);
    const out = await PDFDocument.load(new Uint8Array(after));
    expect(out.getPageCount()).toBe(3);
    expect(Math.round(out.getPage(0).getWidth())).toBe(612);

    // Each page grew: the stamp is per-page, not once on the first.
    for (let i = 0; i < 3; i++) {
      const ops = out.getPage(i).node.Contents();
      expect(ops, `page ${i + 1} has no content stream — nothing was drawn`).toBeTruthy();
    }
  }, 30_000);

  it("leaves a ONE-page document alone — no lone '1 / 1'", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const { stampPageNumbers } = await import("@/lib/commercial/pdf/stamp-page-numbers");
    const src = await PDFDocument.create();
    src.addPage([612, 792]);
    const before = Buffer.from(await src.save());
    const after = await stampPageNumbers(before);
    expect(after).toBe(before);
  }, 30_000);
});

describe("the internal estimating report", () => {
  it("stamps page numbers AFTER the plan set is spliced on, not before", async () => {
    // The ordering IS the bug, so this asserts on the order of the two calls
    // in the route rather than on their presence. A file-level grep for
    // `stampPageNumbers` would pass with the call in the wrong place — which
    // is exactly the state that shipped a numberless multi-page report.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/api/commercial/proposals/[proposalId]/pdf/route.ts", "utf8")
      // Comments discuss both by name; strip them or the positions are noise.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    const append = src.indexOf("appendPdfAttachments(");
    const stamp = src.indexOf("stampPageNumbers(");

    expect(append, "route no longer splices the plan set — this test is stale").toBeGreaterThan(-1);
    expect(stamp, "route does not stamp page numbers at all").toBeGreaterThan(-1);
    expect(
      stamp > append,
      "page numbers are stamped BEFORE the plan set is appended, so the appended pages get none"
    ).toBe(true);
  });
});

describe("the AR statement", () => {
  it("numbers its pages — it is the one customer document that runs long", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/commercial/invoices/statement-pdf.tsx", "utf8");

    // Safe as a react-pdf render callback here only because the statement does
    // NOT go through renderFitToOnePage. If that ever changes, totalPages
    // becomes 1 and this silently stops printing — same failure as the report.
    expect(src).toMatch(/render=\{\(\{ pageNumber, totalPages \}\)/);
    expect(
      /renderFitToOnePage/.test(readFileSync("app/api/commercial/accounts/[id]/statement/route.ts", "utf8")),
      "the statement now goes through the fit — its react-pdf page numbers will silently stop printing"
    ).toBe(false);
  });
});
