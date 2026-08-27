import { describe, it, expect } from "vitest";
import { formatProductLines, parseProductLines, PRODUCT_LINES_MAX } from "@/lib/customer-form/product-lines";

describe("Product_Lines__c formatting (Kate R6.2)", () => {
  it("writes both sides in Kate's format", () => {
    expect(formatProductLines({ interior: "Regal Select", exterior: "Woodluxe" }))
      .toBe("Interior: Regal Select | Exterior: Woodluxe");
  });

  it("includes ONLY the side that applies", () => {
    // "an interior-only job writes Interior: Regal Select and nothing else"
    expect(formatProductLines({ interior: "Regal Select" })).toBe("Interior: Regal Select");
    expect(formatProductLines({ exterior: "Woodluxe" })).toBe("Exterior: Woodluxe");
    expect(formatProductLines({ interior: "Aura", exterior: "" })).toBe("Interior: Aura");
  });

  it("returns empty when nothing was chosen, so callers can skip the write", () => {
    // Writing "" would blank a real answer on any submit that skipped the
    // picker — the field is meant to record a choice, not the absence of one.
    expect(formatProductLines({})).toBe("");
    expect(formatProductLines({ interior: null, exterior: undefined })).toBe("");
    expect(formatProductLines({ interior: "   ", exterior: "\t" })).toBe("");
  });

  it("keeps lines the old picklist had no home for", () => {
    // Ben, Mooreglo, Mooregard and Moore Life have no restricted-picklist
    // equivalent, so every one of them used to be silently dropped.
    for (const line of ["Ben", "Mooreglo", "Mooregard", "Moore Life"]) {
      expect(formatProductLines({ exterior: line })).toBe(`Exterior: ${line}`);
    }
  });

  it("records BOTH sides of a mixed job", () => {
    // The whole reason a text field was asked for: one picklist value could
    // never represent a job with interior and exterior work.
    const out = formatProductLines({ interior: "Regal Select", exterior: "Mooreglo" });
    expect(out).toContain("Regal Select");
    expect(out).toContain("Mooreglo");
  });

  it("never exceeds the Salesforce text limit", () => {
    // STRING_TOO_LONG would reject the whole batch, taking the colours with it.
    const out = formatProductLines({ interior: "X".repeat(400), exterior: "Y".repeat(400) });
    expect(out.length).toBeLessThanOrEqual(PRODUCT_LINES_MAX);
  });

  it("trims stray whitespace rather than storing it", () => {
    expect(formatProductLines({ interior: "  Regal Select  " })).toBe("Interior: Regal Select");
  });

  it("round-trips back into its two sides", () => {
    for (const sel of [
      { interior: "Regal Select", exterior: "Woodluxe" },
      { interior: "Aura" },
      { exterior: "Mooregard" },
    ]) {
      const parsed = parseProductLines(formatProductLines(sel));
      expect(parsed.interior ?? undefined).toBe(sel.interior);
      expect(parsed.exterior ?? undefined).toBe(sel.exterior);
    }
  });

  it("reads a value back tolerantly", () => {
    expect(parseProductLines("Interior: Regal Select|Exterior: Woodluxe").exterior).toBe("Woodluxe");
    expect(parseProductLines("interior:  Aura ").interior).toBe("Aura");
    expect(parseProductLines("")).toEqual({});
    expect(parseProductLines(null)).toEqual({});
    expect(parseProductLines("Regal Select")).toEqual({});   // no label, no guess
  });
});
