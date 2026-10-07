import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const view = readFileSync(join(root, "components/customer-form-view.tsx"), "utf8");
const builder = readFileSync(join(root, "lib/supplier-order/builder.ts"), "utf8");

/**
 * When the Salesforce write fails, the CUSTOMER saw nothing.
 *
 * The banner was gated on `isStaffEntry`, so on the customer path the page
 * said "Thanks — we've got your color picks!" and stopped. True as far as it
 * goes — the picks are saved and ops are alerted automatically — but it is the
 * same screen whether everything worked or half of it did, and a customer
 * whose colors later turn out wrong on the job was never given a reason to
 * mention it.
 */
describe("a failed writeback is admitted to the customer", () => {
  it("renders a customer-facing branch, not only the staff one", () => {
    expect(view).toMatch(/sfWriteFailed && isStaffEntry/);
    expect(view).toMatch(/sfWriteFailed && !isStaffEntry/);
  });

  it("tells them it is saved and that they need do nothing", () => {
    const block = view.slice(view.indexOf("sfWriteFailed && !isStaffEntry"));
    expect(block).toMatch(/Your colors are saved/);
    expect(block).toMatch(/nothing\s*\n?\s*you need to do|nothing you need to do/);
  });

  it("says nothing about our plumbing", () => {
    // None of this is the customer's to carry. The staff banner names
    // Salesforce; this one must not.
    const block = view.slice(
      view.indexOf("sfWriteFailed && !isStaffEntry"),
      view.indexOf("sfWriteFailed && !isStaffEntry") + 1200
    );
    for (const word of ["Salesforce", "Command Center", "writeback", "API"]) {
      expect(block, word).not.toContain(word);
    }
  });

  it("is a status, not an alarm", () => {
    // role="alert" interrupts a screen reader. Nothing is wrong from the
    // customer's side, so this announces politely.
    const block = view.slice(view.indexOf("sfWriteFailed && !isStaffEntry"), view.indexOf("sfWriteFailed && !isStaffEntry") + 400);
    expect(block).toMatch(/role="status"/);
  });
});

/**
 * A line with a quantity, a product, a sheen — and no color.
 */
describe("a vendor line always names a color", () => {
  it("marks a missing color instead of printing a blank", () => {
    // formatColorLabel returns "" when name and code are both blank.
    expect(builder).toMatch(/formatColorLabel\(e\.colorName, e\.colorCode\) \|\| "\[COLOR NOT SET\]"/);
  });

  it("does not silently drop the line", () => {
    // PPP is still buying it. A missing line is the one nobody notices until
    // the crew is on site — louder is safer than absent.
    const region = builder.slice(builder.indexOf("const label = formatColorLabel"), builder.indexOf("const label = formatColorLabel") + 400);
    expect(region).not.toMatch(/if \(!label\) continue/);
  });
});
