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
