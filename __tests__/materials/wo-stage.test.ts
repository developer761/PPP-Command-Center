import { describe, it, expect } from "vitest";
import { deriveWoStage, STAGE_BADGES, type StageProgress } from "@/lib/materials/wo-stage";

const at = (d: string) => `2026-08-${d}T12:00:00Z`;

describe("the work-order stage tag (Kate, batch 6)", () => {
  it("no longer stops at Submitted once the paint is ordered", () => {
    // The whole report: "the tag on work orders is Submitted no matter where
    // the work order is in the order progression."
    const p: StageProgress = { formSentAt: at("01"), formOpenedAt: at("02"), formSubmittedAt: at("03"), supplierSentAt: at("04") };
    expect(deriveWoStage({ status: "submitted" }, p)).toBe("ordered");
  });

  it("walks the whole progression in order", () => {
    const steps: Array<[StageProgress, string]> = [
      [{ formSentAt: at("01") }, "sent"],
      [{ formSentAt: at("01"), formOpenedAt: at("02") }, "opened"],
      [{ formSentAt: at("01"), formOpenedAt: at("02"), formSubmittedAt: at("03") }, "submitted"],
      [{ formSubmittedAt: at("03"), supplierSentAt: at("04") }, "ordered"],
      [{ formSubmittedAt: at("03"), supplierSentAt: at("04"), materialsDeliveredAt: at("06") }, "delivered"],
    ];
    for (const [p, want] of steps) expect(deriveWoStage(null, p)).toBe(want);
  });

  it("shows cancelled when every order was cancelled", () => {
    expect(deriveWoStage(null, { formSubmittedAt: at("03"), supplierSentAt: at("04"), supplierCancelledAt: at("05") }))
      .toBe("cancelled");
  });

  it("delivered outranks cancelled — paint that arrived cannot un-arrive", () => {
    expect(deriveWoStage(null, {
      supplierSentAt: at("04"), supplierCancelledAt: at("05"), materialsDeliveredAt: at("06"),
    })).toBe("delivered");
  });

  it("ranks by progression, not by clock", () => {
    // These timestamps do not always arrive in order and some never arrive at
    // all. A late-lapsing token must not drag a delivered job backwards.
    expect(deriveWoStage({ status: "expired" }, { formSubmittedAt: at("03"), materialsDeliveredAt: at("02") }))
      .toBe("delivered");
  });

  it("an expired token after a submission is still submitted", () => {
    expect(deriveWoStage({ status: "expired" }, { formSubmittedAt: at("03") })).toBe("submitted");
  });

  it("but expired beats opened and sent, because only it needs an action", () => {
    expect(deriveWoStage({ status: "expired" }, { formSentAt: at("01"), formOpenedAt: at("02") })).toBe("expired");
  });

  it("falls back to the form status when timestamps are missing", () => {
    expect(deriveWoStage({ status: "opened" }, {})).toBe("opened");
    expect(deriveWoStage({ status: "sent" }, null)).toBe("sent");
    expect(deriveWoStage({ status: "submitted" }, undefined)).toBe("submitted");
  });

  it("shows nothing at all when no form was ever sent", () => {
    expect(deriveWoStage({ status: "none" }, {})).toBe("none");
    expect(deriveWoStage(null, null)).toBe("none");
    expect(deriveWoStage(undefined, undefined)).toBe("none");
  });

  it("labels every stage exactly as Kate wrote them", () => {
    expect(STAGE_BADGES.sent.label).toBe("🎨 Sent");
    expect(STAGE_BADGES.opened.label).toBe("🎨 Opened");
    expect(STAGE_BADGES.submitted.label).toBe("🎨 Submitted");
    expect(STAGE_BADGES.ordered.label).toBe("🚛 Ordered");
    expect(STAGE_BADGES.cancelled.label).toBe("🚛 Canceled");
    expect(STAGE_BADGES.delivered.label).toBe("🚛 Delivered");
  });

  it("uses the palette for the form phase and the lorry for the order phase", () => {
    for (const k of ["sent", "opened", "submitted"] as const) expect(STAGE_BADGES[k].label).toContain("🎨");
    for (const k of ["ordered", "cancelled", "delivered"] as const) expect(STAGE_BADGES[k].label).toContain("🚛");
  });

  it("every reachable stage has a badge", () => {
    const reachable = ["sent", "opened", "submitted", "expired", "ordered", "cancelled", "delivered"] as const;
    for (const s of reachable) {
      expect(STAGE_BADGES[s], `no badge for ${s}`).toBeTruthy();
      expect(STAGE_BADGES[s].title.length).toBeGreaterThan(10);
    }
  });
});
