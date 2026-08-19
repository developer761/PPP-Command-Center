import { describe, it, expect } from "vitest";
import { roomLabelFrom } from "@/lib/customer-form/room-label";

/**
 * R4.20 — WO 00306643 showed "Untitled Area" on all three line items. Verified
 * against the live org: AreaLabel__c really is null on every one of them, so
 * the fallback was behaving; the room names were sitting unused in
 * ProductName__c. The strings below are the production values.
 */
describe("roomLabelFrom", () => {
  it("prefers AreaLabel__c when it's there", () => {
    expect(roomLabelFrom("Kitchen", "Interior Painting: Kitchen: Kitchen")).toBe("Kitchen");
    expect(roomLabelFrom("  Living Room  ", null)).toBe("Living Room");
  });

  it("falls back to the last segment of ProductName__c", () => {
    // Three-segment form (WO 00308360).
    expect(roomLabelFrom(null, "Interior Painting: Living Room: Living Room")).toBe("Living Room");
    // Two-segment form (WO 00306643) — both occur in production.
    expect(roomLabelFrom(null, "Interior Painting: Bathroom")).toBe("Bathroom");
    expect(roomLabelFrom(null, "Interior Painting: Bedroom")).toBe("Bedroom");
    expect(roomLabelFrom(null, "Interior Painting: Dining Room")).toBe("Dining Room");
    expect(roomLabelFrom("", "Exterior Painting: Siding")).toBe("Siding");
  });

  it("won't pass the product family off as a room name", () => {
    // A line item with genuinely no area — inventing "Interior Painting" as a
    // room would read like a real room and be worse than admitting we don't know.
    expect(roomLabelFrom(null, "Interior Painting")).toBe("Untitled area");
    expect(roomLabelFrom(null, "Exterior Painting")).toBe("Untitled area");
    expect(roomLabelFrom(null, "Interior Painting: Interior Painting")).toBe("Untitled area");
  });

  it("degrades to the caller's fallback", () => {
    expect(roomLabelFrom(null, null)).toBe("Untitled area");
    expect(roomLabelFrom(null, "")).toBe("Untitled area");
    expect(roomLabelFrom(null, "   :  : ")).toBe("Untitled area");
    // Callers use different wording in different surfaces; honour it.
    expect(roomLabelFrom(null, null, "Unnamed room")).toBe("Unnamed room");
  });
});
