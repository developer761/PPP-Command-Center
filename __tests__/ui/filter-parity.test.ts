import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * R4.4 — "Duplicate the same filter set onto the work-order list so a WO can be
 * found the same way a message can."
 *
 * Same set means same look and same behaviour. Two hand-copied class strings
 * drift the first time either row is touched, and then only one of them has the
 * 44px mobile tap target or the focus ring — so both rows read their chrome
 * from one module, and this asserts neither has quietly re-inlined it.
 */
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const materials = read("components/materials-view.tsx");
const inbox = read("components/inbox-view.tsx");

describe("the two filter rows share their chrome", () => {
  it.each([
    ["components/materials-view.tsx", materials],
    ["components/inbox-view.tsx", inbox],
  ])("%s imports the shared styles", (_name, src) => {
    expect(src).toContain('from "@/lib/ui/filter-chrome"');
  });

  it("neither re-inlines the select styling", () => {
    // The literal that used to be duplicated. If it reappears, the rows have
    // started to diverge again.
    const inlined = /rounded-lg border border-ppp-charcoal-200 px-2 py-1\.5 text-base/;
    expect(inlined.test(materials), "materials-view re-inlined FILTER_SEL").toBe(false);
    expect(inlined.test(inbox), "inbox-view re-inlined FILTER_SEL").toBe(false);
  });

  it("both offer status and date filters", () => {
    for (const [name, src] of [["materials", materials], ["inbox", inbox]] as const) {
      // Status differs in vocabulary between them — pipeline stage vs delivery
      // state — but both must have one, and both must have dates.
      expect(src, `${name} lost the status filter`).toMatch(/>Status</);
      expect(src, `${name} lost the date filter`).toMatch(/>Date</);
      expect(src, `${name} lost Clear all`).toContain("Clear all");
    }
  });

  it("only Mail Hub has a sender filter", () => {
    // R5.4 — the Materials list had one briefly (R4.4, when Kate asked for "the
    // same filter set"). It matched whoever sent the COLOUR FORM, which says
    // nothing about the work order, so most rows had no sender and choosing one
    // emptied the list. Sender is a question about a message; Mail Hub keeps it.
    expect(inbox, "Mail Hub should still filter by sender").toMatch(/>Sender</);
    expect(materials, "the Materials list should NOT have a sender filter").not.toMatch(/>Sender</);
  });

  it("both can find a cancelled order", () => {
    // R5.8 — asked for on both filters, and they reach it differently: the
    // Materials list asks whether the WORK ORDER's orders were all cancelled,
    // Mail Hub asks whether THIS message's order was.
    expect(materials).toMatch(/value="cancelled"/);
    expect(inbox).toMatch(/value="order_cancelled"/);
  });

  it("both drop rows with no date on the chosen dimension", () => {
    // Otherwise "opened last week" returns every work order nobody ever opened.
    expect(materials).toMatch(/if \(!d\) return false;/);
    expect(inbox).toMatch(/if \(!d\) return false;/);
  });
});
