import { describe, it, expect } from "vitest";
import { toE164, isE164, formatUs } from "@/lib/messaging/phone";

const NASSAU = "+15163448418"; // the one workspace number we have verified

describe("toE164 — every shape a real number arrives in", () => {
  it("normalises the same number written eight ways", () => {
    for (const s of [
      "(516) 344-8418", "516-344-8418", "5163448418", "1-516-344-8418",
      "+1 516 344 8418", "+15163448418", "516.344.8418", " 516 344 8418 ",
    ]) {
      expect(toE164(s)).toBe(NASSAU);
    }
  });

  it("strips tel: hrefs and trailing extensions", () => {
    expect(toE164("tel:+15163448418")).toBe(NASSAU);
    expect(toE164("516-344-8418 x123")).toBe(NASSAU);
    expect(toE164("516-344-8418 ext. 9")).toBe(NASSAU);
  });

  it("handles non-breaking spaces and full-width digits", () => {
    expect(toE164("516 344 8418")).toBe(NASSAU);
    expect(toE164("５１６３４４８４１８")).toBe(NASSAU);
  });

  it("returns null rather than guessing", () => {
    for (const s of [
      "", "   ", "abc", "12345", "516-344", "0163448418", "1163448418",
      "516-044-8418", "516-144-8418", null, undefined,
    ]) {
      expect(toE164(s as string)).toBeNull();
    }
  });

  it("rejects the reserved 555-01XX fictional range", () => {
    expect(toE164("212-555-0123")).toBeNull();
    // 555 outside the 01XX block is a real assignable exchange.
    expect(toE164("212-555-1234")).toBe("+12125551234");
  });

  it("passes through a non-NANP international number unmangled", () => {
    expect(toE164("+442071838750")).toBe("+442071838750");
    expect(toE164("+33 1 42 68 53 00")).toBe("+33142685300");
  });

  it("is idempotent — normalising twice changes nothing", () => {
    const once = toE164("(516) 344-8418")!;
    expect(toE164(once)).toBe(once);
  });

  it("collapses variants to ONE key, which is the whole point", () => {
    // If these ever differ, an opt-out row exists that the send path misses.
    const keys = new Set(
      ["(516) 344-8418", "516.344.8418", "1 516 344 8418", "+1-516-344-8418"]
        .map((s) => toE164(s))
    );
    expect(keys.size).toBe(1);
  });
});

describe("isE164 / formatUs", () => {
  it("accepts only well-formed E.164", () => {
    expect(isE164(NASSAU)).toBe(true);
    for (const s of ["5163448418", "+0163448418", "+1516344841x", ""]) {
      expect(isE164(s)).toBe(false);
    }
  });

  it("formats for humans without becoming the stored value", () => {
    expect(formatUs(NASSAU as never)).toBe("(516) 344-8418");
  });
});
