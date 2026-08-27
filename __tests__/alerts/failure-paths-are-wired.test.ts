import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Kate R6.1 asked to be told about "any and all failures and errors on the
 * paint tool / materials side". The alert channel is only worth having if it is
 * actually connected, and a call inside a catch block is the easiest thing in
 * the world to delete during an unrelated refactor without anyone noticing —
 * the tests still pass, the feature still works, and the alerting quietly stops.
 *
 * So each named failure path is pinned to its file here, with the reason.
 */
const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("every failure Kate named reaches Slack", () => {
  it("a bounced supplier order alerts — the order looks sent but the vendor has nothing", () => {
    const src = read("app/api/webhooks/resend-events/route.ts");
    expect(src).toMatch(/alertMaterialsFailure/);
    expect(src).toMatch(/supplier_order_bounced/);
  });

  it("a bounced colour form alerts — the job sits waiting on colours", () => {
    const src = read("app/api/webhooks/resend-events/route.ts");
    expect(src).toMatch(/color_form_bounced/);
  });

  it("the bounce alert covers complaints and failures, not only hard bounces", () => {
    const src = read("app/api/webhooks/resend-events/route.ts");
    for (const s of ["bounced", "complained", "failed"]) expect(src).toContain(`"${s}"`);
  });

  it("a supplier order that never sends alerts — only the sender saw the error", () => {
    const src = read("app/api/admin/supplier-order/send/route.ts");
    expect(src).toMatch(/supplier_order_send_failed/);
  });

  it("an unexpected throw in the send route alerts too — Kate said ANY failure", () => {
    const src = read("app/api/admin/supplier-order/send/route.ts");
    expect(src).toMatch(/unexpected_error/);
  });

  it("EVERY Salesforce rejection alerts, wired at the write and not per caller", () => {
    // Wiring it at each call site means the next writeback someone adds is
    // silently unmonitored — which is exactly how the paint-line write went on
    // failing from 2026-07-14 with nobody the wiser.
    const src = read("lib/salesforce/writeback.ts");
    expect(src).toMatch(/alertMaterialsFailure/);
    expect(src).toMatch(/salesforce_write_rejected/);
  });

  it("the follow-up date is covered by that, which is why it is not wired separately", () => {
    // Kate: "the follow-up date does too, and a rejection there is shown only
    // to the person on screen." It routes through writeSf, so the hook above
    // catches it. If it ever stops doing so, this fails.
    const src = read("app/api/dashboard/materials/followup/route.ts");
    expect(src, "follow-up no longer goes through writeSf — wire it directly").toMatch(/writeSf/);
  });

  it("the alert path itself cannot fail silently", () => {
    const src = read("lib/alerts/materials-alerts.ts");
    expect(src, "no email fallback when Slack is down").toMatch(/emailFallback/);
    expect(src, "nothing marks a wholly undelivered alert").toMatch(/UNDELIVERED/);
  });
});
