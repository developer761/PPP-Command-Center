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

  it("both offer the same three filter groups", () => {
    for (const [name, src] of [["materials", materials], ["inbox", inbox]] as const) {
      // Sender and Date are shared concepts; Status differs in vocabulary
      // (pipeline stage vs delivery state) but must exist on both.
      expect(src, `${name} lost the sender filter`).toMatch(/>Sender</);
      expect(src, `${name} lost the status filter`).toMatch(/>Status</);
      expect(src, `${name} lost the date filter`).toMatch(/>Date</);
      expect(src, `${name} lost Clear all`).toContain("Clear all");
    }
  });

  it("both drop rows with no date on the chosen dimension", () => {
    // Otherwise "opened last week" returns every work order nobody ever opened.
    expect(materials).toMatch(/if \(!d\) return false;/);
    expect(inbox).toMatch(/if \(!d\) return false;/);
  });
});
