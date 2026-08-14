import { describe, it, expect } from "vitest";
import { extractCustomerFreeText } from "@/lib/customer-form/notes";

describe("extractCustomerFreeText — pre-fill only shows the customer's own text", () => {
  it("returns empty for null/empty", () => {
    expect(extractCustomerFreeText(null)).toBe("");
    expect(extractCustomerFreeText("")).toBe("");
    expect(extractCustomerFreeText("   ")).toBe("");
  });

  it("passes crew-written notes through unchanged (no wrapper)", () => {
    expect(extractCustomerFreeText("Use flat finish on the ceiling")).toBe(
      "Use flat finish on the ceiling"
    );
  });

  it("keeps only the human tail after the Customer notes: wrapper", () => {
    expect(extractCustomerFreeText("Customer notes: Please use low-VOC paint")).toBe(
      "Please use low-VOC paint"
    );
  });

  it("strips a single skip line + wrapper (no orphan)", () => {
    const raw =
      'Customer selected "Don\'t paint this surface" on Trim.\n\nCustomer notes: Careful around the piano';
    expect(extractCustomerFreeText(raw)).toBe("Careful around the piano");
  });

  it("drops the orphan-color preamble AND skip lines, keeping only the tail (#27 double-wrap guard)", () => {
    const raw =
      'Cabinets: White — Semi-Gloss\n\nCustomer selected "Don\'t paint this surface" on Trim.\n\nCustomer notes: Ring the bell';
    expect(extractCustomerFreeText(raw)).toBe("Ring the bell");
  });

  it("is idempotent: re-extracting its own output is stable", () => {
    const raw =
      'Cabinets: White\n\nCustomer notes: See the door';
    const once = extractCustomerFreeText(raw);
    expect(extractCustomerFreeText(once)).toBe(once);
  });

  it("preserves a customer's own embedded 'Customer notes:' phrase (first occurrence = wrapper)", () => {
    const raw = "Customer notes: also see Customer notes: on the garage";
    expect(extractCustomerFreeText(raw)).toBe("also see Customer notes: on the garage");
  });
});

/**
 * Kate round-3 #31 — Color Notes carry a real room name and one surface per
 * line. That gave the machine-generated preamble a header line, so extraction
 * has to drop the header too when what follows is ours.
 */
describe("extractCustomerFreeText — round-3 #31 room headers", () => {
  it("drops a room header + orphan colour lines when there is no customer note", () => {
    const raw = [
      "Dining Room:",
      "Cabinets: HC-15 Henderson Buff (HC-15) — Semi-Gloss",
      "Door: 2108-40 Stardust (2108-40) — Semi-Gloss",
    ].join("\n");
    expect(extractCustomerFreeText(raw)).toBe("");
  });

  it("keeps the customer's note and drops the header block around it", () => {
    // The shape the submit route actually writes: ONE header, then the orphan
    // colours, then the customer's own words.
    const raw = [
      "Dining Room:",
      "Cabinets: HC-15 Henderson Buff (HC-15) — Semi-Gloss",
      "",
      "Customer notes: Dave approved the accent wall",
    ].join("\n");
    expect(extractCustomerFreeText(raw)).toBe("Dave approved the accent wall");
  });

  it("drops a header that sits directly above the customer note (no orphans)", () => {
    const raw = ["Kitchen:", "Customer notes: Low-VOC please"].join("\n");
    expect(extractCustomerFreeText(raw)).toBe("Low-VOC please");
  });

  it("does NOT eat a crew note that happens to start with its own heading", () => {
    const raw = "Kitchen:\nWatch the new cabinets, they are still curing";
    expect(extractCustomerFreeText(raw)).toBe(
      "Kitchen:\nWatch the new cabinets, they are still curing"
    );
  });
});
