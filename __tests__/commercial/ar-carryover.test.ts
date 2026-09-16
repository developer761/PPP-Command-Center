import { describe, it, expect } from "vitest";
import {
  AR_CARRYOVER,
  AR_CARRYOVER_TOTAL_CENTS,
  arCarryoverTotal,
} from "@/lib/commercial/reports/tomco/ar-carryover";

/**
 * Mary's sheet was read out of a PDF. The only way to know it was read
 * correctly is that it adds up to the total printed on it.
 */
describe("Mary's AR sheet, copied", () => {
  it("adds up to the $314,048.14 printed at the foot of her sheet", () => {
    expect(arCarryoverTotal()).toBe(AR_CARRYOVER_TOTAL_CENTS);
    expect(arCarryoverTotal()).toBe(31_404_814);
  });

  it("has all 22 lines, each with a job, an amount and her note", () => {
    expect(AR_CARRYOVER).toHaveLength(22);
    for (const r of AR_CARRYOVER) {
      expect(r.job.trim(), JSON.stringify(r)).not.toBe("");
      expect(r.openCents, JSON.stringify(r)).toBeGreaterThan(0);
      expect(r.note.trim(), JSON.stringify(r)).not.toBe("");
    }
  });

  it("keeps the biggest line intact — it is 57% of the sheet", () => {
    // $177,733.93 on LMJ - AIREF. If a digit slipped here the total would
    // still be checkable, but this is the line worth naming.
    const airef = AR_CARRYOVER.find((r) => r.openCents === 17_773_393);
    expect(airef).toBeDefined();
    expect(airef?.job).toBe("LMJ - AIREF");
  });
});
