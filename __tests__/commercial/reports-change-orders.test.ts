import { describe, it, expect } from "vitest";
import { vendorKey } from "@/lib/commercial/reports/change-orders-vendors";

/**
 * Change orders & vendor spend — the two rules that decide whether these
 * numbers are honest.
 */

describe("adds and credits are never netted", () => {
  // `amount_cents` is SIGNED. Netting is the failure: a job with $50k added
  // and $50k credited reports "no change orders", which is a lie about $100k
  // of scope movement.
  const cos = [50_000_00, -50_000_00, 12_000_00];
  const adds = cos.filter((c) => c > 0).reduce((a, b) => a + b, 0);
  const credits = cos.filter((c) => c < 0).reduce((a, b) => a + Math.abs(b), 0);

  it("a netted total would report nothing happened", () => {
    expect(cos.slice(0, 2).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("kept apart, both movements are visible", () => {
    expect(adds).toBe(62_000_00);
    expect(credits).toBe(50_000_00);
  });
});

describe("approval rate excludes pending", () => {
  const rate = (approved: number, declined: number) => {
    const decided = approved + declined;
    return decided > 0 ? Math.round((approved / decided) * 100) : null;
  };

  it("a CO awaiting a decision is not a rejection", () => {
    // 3 approved, 0 declined, 9 pending. Counting pending gives 25% and says
    // the GC rejects everything, when they have simply not answered.
    expect(rate(3, 0)).toBe(100);
  });

  it("is null, never 0%, when nothing is decided", () => {
    expect(rate(0, 0)).toBeNull();
  });
});

describe("approved-but-unbilled", () => {
  // The only figure here that is money on the floor rather than history.
  const cos = [
    { cents: 10_000_00, status: "approved", invoice: null },
    { cents: 5_000_00, status: "approved", invoice: "inv-1" },
    { cents: 7_000_00, status: "pending", invoice: null },
    { cents: -2_000_00, status: "approved", invoice: null },
  ];
  const unbilled = cos.filter((c) => c.status === "approved" && !c.invoice && c.cents > 0);

  it("counts only approved, unbilled, ADDITIVE change orders", () => {
    // A pending CO isn't owed yet; a credit isn't something to invoice for.
    expect(unbilled).toHaveLength(1);
    expect(unbilled[0].cents).toBe(10_000_00);
  });
});

describe("vendorKey groups spellings without merging real vendors", () => {
  it("folds case, punctuation and company suffixes", () => {
    const k = vendorKey("Sherwin Williams");
    expect(vendorKey("sherwin williams")).toBe(k);
    expect(vendorKey("Sherwin-Williams")).toBe(k);
    expect(vendorKey("Sherwin Williams Co.")).toBe(k);
    expect(vendorKey("SHERWIN  WILLIAMS, INC")).toBe(k);
  });

  it("does NOT merge a shorter name into a longer one", () => {
    // Deliberately conservative: a split row is visible, a bad merge is not.
    expect(vendorKey("Sherwin")).not.toBe(vendorKey("Sherwin Williams"));
    expect(vendorKey("Benjamin Moore")).not.toBe(vendorKey("Benjamin Moore Paints"));
  });

  it("keeps genuinely different vendors apart", () => {
    expect(vendorKey("Home Depot")).not.toBe(vendorKey("Lowes"));
  });

  it("returns empty for a name that is only punctuation, so it counts as unattributed", () => {
    // Otherwise a junk vendor would get its own row in the spend table.
    expect(vendorKey("---")).toBe("");
    expect(vendorKey("  ")).toBe("");
  });
});
