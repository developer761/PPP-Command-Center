import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveOrderStages, isCancelledOrder, type OrderStageRow } from "@/lib/wo-progress/order-stages";

/**
 * R5.5 — "A cancelled order still shows the work order as ordered."
 *
 * Both progress loaders derived every stage from ALL supplier_orders rows
 * without looking at `status`, so cancelling changed nothing a reader could
 * see: the Materials list still said ordered, the Ordered filter still returned
 * it, the progress bar stayed advanced.
 */
const row = (o: Partial<OrderStageRow> = {}): OrderStageRow => ({
  supplier_account_id: "s1",
  supplier_name: "Aboffs",
  status: "sent",
  created_at: "2026-08-20T10:00:00Z",
  sent_at: "2026-08-20T10:05:00Z",
  acknowledged_at: null,
  delivered_at: null,
  cancelled_at: null,
  ...o,
});

describe("deriveOrderStages", () => {
  it("a work order whose only order was cancelled is not ordered", () => {
    const s = deriveOrderStages([row({ status: "cancelled", cancelled_at: "2026-08-21T09:00:00Z" })]);
    expect(s.supplierSentAt).toBeNull();
    expect(s.supplierDraftedAt).toBeNull();
    expect(s.supplierCancelledAt).toBe("2026-08-21T09:00:00Z");
  });

  it("keeps the cancelled order visible in the timeline", () => {
    // The vendor was emailed a real order. Erasing it would be worse than the
    // bug — the record has to show what happened.
    const s = deriveOrderStages([row({ status: "cancelled", cancelled_at: "2026-08-21T09:00:00Z" })]);
    expect(s.perSupplier).toHaveLength(1);
    expect(s.perSupplier[0].cancelledAt).toBe("2026-08-21T09:00:00Z");
    expect(s.perSupplier[0].supplierName).toBe("Aboffs");
  });

  it("a WO with one cancelled and one live order is STILL ordered", () => {
    const s = deriveOrderStages([
      row({ status: "cancelled", cancelled_at: "2026-08-21T09:00:00Z", sent_at: "2026-08-20T10:05:00Z" }),
      row({ supplier_account_id: "s2", sent_at: "2026-08-22T11:00:00Z" }),
    ]);
    expect(s.supplierSentAt).toBe("2026-08-22T11:00:00Z");
    // Not cancelled — showing it as such would be a lie.
    expect(s.supplierCancelledAt).toBeNull();
  });

  it("does not let a cancelled order's timestamp become the sent date", () => {
    // The cancelled one is EARLIER, so a min() over all rows would pick it.
    const s = deriveOrderStages([
      row({ status: "cancelled", sent_at: "2026-08-01T08:00:00Z", cancelled_at: "2026-08-02T08:00:00Z" }),
      row({ supplier_account_id: "s2", sent_at: "2026-08-20T10:05:00Z" }),
    ]);
    expect(s.supplierSentAt).toBe("2026-08-20T10:05:00Z");
  });

  it("ignores a cancelled order when deciding 'all suppliers acknowledged'", () => {
    // A cancelled order will never be acknowledged. Counting it would hold the
    // stage open forever on a job whose live orders are all confirmed.
    const s = deriveOrderStages([
      row({ status: "cancelled", cancelled_at: "2026-08-21T09:00:00Z" }),
      row({ supplier_account_id: "s2", acknowledged_at: "2026-08-22T12:00:00Z" }),
    ]);
    expect(s.supplierAcknowledgedAt).toBe("2026-08-22T12:00:00Z");
  });

  it("treats a stamped cancelled_at as cancelled even if status lags", () => {
    expect(isCancelledOrder({ status: "sent", cancelled_at: "2026-08-21T09:00:00Z" })).toBe(true);
    expect(isCancelledOrder({ status: "cancelled", cancelled_at: null })).toBe(true);
    expect(isCancelledOrder({ status: "sent", cancelled_at: null })).toBe(false);
  });

  it("handles a work order with no orders at all", () => {
    const s = deriveOrderStages([]);
    expect(s.supplierSentAt).toBeNull();
    expect(s.supplierCancelledAt).toBeNull();
    expect(s.perSupplier).toEqual([]);
  });
});

/**
 * Round 3 #02/#03 was two progress loaders drifting apart — attribution added
 * to one and not the other, so the page Kate tested kept reading the old value.
 * This is the same shape of logic in the same two places, so it lives in one
 * module and both must use it.
 */
/**
 * Pass-3 finding: fixing "still shows ordered" made the bar retreat to "never
 * ordered" with nothing explaining why. Technically correct, but it reads as
 * though the order vanished — the opposite over-correction, and the next
 * round's complaint. The retreat has to come with a reason.
 */
describe("a cancellation is explained, not just subtracted", () => {
  const bar = readFileSync(join(process.cwd(), "components/work-order-progress-bar.tsx"), "utf8");

  it("says the order was cancelled", () => {
    expect(bar).toContain("progress.supplierCancelledAt &&");
    expect(bar).toMatch(/Order cancelled/);
  });

  it("tells the admin what to do next", () => {
    // Re-sending is exactly what they're there for — and, before R5.6, exactly
    // what was blocked.
    expect(bar).toMatch(/needs a\s*\n?\s*new materials order/);
  });

  it("is honest that the vendor still has the original", () => {
    // R5.5's held half: no cancellation notice goes out. Someone reading this
    // bar must not assume the vendor knows.
    expect(bar).toMatch(/vendor was not notified/);
  });

  it("labels the per-supplier row cancelled rather than falling back to Sent", () => {
    expect(bar).toMatch(/s\.cancelledAt \? `Cancelled/);
  });
});

describe("both progress loaders share the derivation", () => {
  const LOADERS = ["lib/wo-progress/derive.ts", "lib/materials-page-data.ts"];
  it.each(LOADERS)("%s calls deriveOrderStages", (rel) => {
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    expect(src).toContain("deriveOrderStages(rows)");
    // And selects cancelled_at — deriving from a column you didn't fetch is
    // how this stays half-fixed.
    expect(src).toContain("ORDER_STAGE_COLUMNS");
  });

  it("neither re-implements the stage maths locally", () => {
    for (const rel of LOADERS) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      expect(src, `${rel} still hand-rolls the ack rule`).not.toMatch(
        /rows\.every\(\(r\) => r\.acknowledged_at\)/
      );
    }
  });
});
