import { describe, it, expect } from "vitest";
import {
  computeWarrantyEndDate,
  closeoutProgressPct,
  ALLOWED_CLOSEOUT_TRANSITIONS,
  isCloseoutEditable,
} from "@/lib/commercial/closeout/constants";

describe("computeWarrantyEndDate", () => {
  it("adds the term in whole years, no timezone drift", () => {
    expect(computeWarrantyEndDate("2026-07-15", 2)).toBe("2028-07-15");
    expect(computeWarrantyEndDate("2026-02-29", 1)).toBe("2027-02-29"); // date-string math, no Date rollover
  });
  it("null start → null", () => {
    expect(computeWarrantyEndDate(null, 2)).toBeNull();
    expect(computeWarrantyEndDate("garbage", 2)).toBeNull();
  });
  it("0-year term returns the same date", () => {
    expect(computeWarrantyEndDate("2026-07-15", 0)).toBe("2026-07-15");
  });
});

describe("closeoutProgressPct", () => {
  const item = (included: boolean, item_status: "pending" | "received" | "na") => ({ included, item_status });
  it("counts received + na over included items", () => {
    expect(closeoutProgressPct([item(true, "received"), item(true, "na"), item(true, "pending")])).toBe(67);
  });
  it("excluded items don't count in the denominator", () => {
    expect(closeoutProgressPct([item(true, "received"), item(false, "pending")])).toBe(100);
  });
  it("null when no included items", () => {
    expect(closeoutProgressPct([item(false, "pending")])).toBeNull();
    expect(closeoutProgressPct([])).toBeNull();
  });
});

describe("closeout status DAG", () => {
  it("only a draft is editable", () => {
    expect(isCloseoutEditable("draft")).toBe(true);
    expect(isCloseoutEditable("sent")).toBe(false);
    expect(isCloseoutEditable("complete")).toBe(false);
  });
  it("terminal states have no forward transitions", () => {
    expect(ALLOWED_CLOSEOUT_TRANSITIONS.complete).toEqual([]);
    expect(ALLOWED_CLOSEOUT_TRANSITIONS.voided).toEqual([]);
  });
  it("draft can go to sent or voided, not straight to complete", () => {
    expect(ALLOWED_CLOSEOUT_TRANSITIONS.draft).toContain("sent");
    expect(ALLOWED_CLOSEOUT_TRANSITIONS.draft).not.toContain("complete");
  });
});
