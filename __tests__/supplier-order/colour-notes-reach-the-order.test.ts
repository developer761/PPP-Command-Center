import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractCustomerFreeText, extractMachineColorLines } from "@/lib/customer-form/notes";

/**
 * Katie item 23 — "colour notes never reach the order", the biggest single gap
 * on the list.
 *
 * WO 00316248, checked against production: a rep put the ENTIRE exterior on one
 * line item, wrote "see notes for colors" in Description, and put the actual
 * colours in Colour Notes. The vendor cannot fill that order without them.
 *
 * This REVERSES R4.14, which removed COLOR NOTES from the vendor email on the
 * grounds that colour notes inform the estimator, not the supplier. Both are
 * right about different content, so only the customer-facing FREE TEXT is sent
 * — the colours a person wrote. Machine-written lines, the "Not painting:" list
 * and skipped surfaces stay internal, which is the bookkeeping R4.14 meant.
 */
const ROOT = join(__dirname, "..", "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

/** Verbatim from WO 00316248. */
const REAL = [
  "Customer notes: Siding: HC-6 Windham Cream - Low Lustre",
  "Trim: OC-95 Navajo White - Soft Gloss",
  "Shutters, Doors, and Iron Railings: 447 Holiday Wreath - Satin",
].join("\n");

describe("why it never came through", () => {
  it("the machine parser finds nothing in a rep's free text", () => {
    // This is the whole bug. The order path read colour notes through
    // extractMachineColorLines, which only understands OUR written format, so a
    // hand-typed colour list was invisible to it.
    expect(extractMachineColorLines(REAL)).toEqual([]);
  });

  it("the free-text parser finds the colours", () => {
    const t = extractCustomerFreeText(REAL);
    expect(t).toContain("HC-6 Windham Cream");
    expect(t).toContain("Soft Gloss");
    expect(t).toContain("447 Holiday Wreath");
  });
});

describe("the colours reach both surfaces", () => {
  it("the order screen carries them, apart from the scope", () => {
    const data = read("lib/materials/order-page-data.ts");
    expect(data).toMatch(/colorNotes: extractCustomerFreeText\(li\.raw\.colorNotes\)/);
    // Two DIFFERENT things on one line — the scope and the colours — so each is
    // labelled. Unlabelled, a reader cannot tell which is which.
    const view = read("components/order-builder-view.tsx");
    expect(view).toMatch(/label="Scope"/);
    expect(view).toMatch(/label="Colours"/);
  });

  it("the vendor email carries them", () => {
    const b = read("lib/supplier-order/builder.ts");
    expect(b).toMatch(/sections\.push\("COLOR NOTES"\)/);
    expect(b).toMatch(/extractCustomerFreeText\(li\.colorNotes\)/);
  });

  it("but NOT the internal bookkeeping R4.14 was about", () => {
    // colorNotesDefault holds the machine lines, the "Not painting:" list and
    // the skipped surfaces. Sending that blob to a supplier is what R4.14
    // stopped, and it stays stopped.
    const b = read("lib/supplier-order/builder.ts");
    expect(b).toMatch(/void colorNotesDefault;/);
    expect(b).not.toMatch(/sections\.push\(colorNotesDefault\)/);
  });

  it("nothing is sent when a line has no colour notes", () => {
    // An empty "COLOR NOTES" header reads to a vendor like a truncated message.
    expect(extractCustomerFreeText(null).trim()).toBe("");
    expect(extractCustomerFreeText("").trim()).toBe("");
  });
});
