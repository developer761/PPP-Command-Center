import { describe, expect, it } from "vitest";
import {
  DEMO_TERMS,
  demoEnabled,
  demoWorkOrder,
  demoWorkOrderNumber,
  isDemoWorkOrderId,
  newDemoWorkOrderId,
} from "@/lib/payments/demo";
import { buildPaymentSchedule } from "@/lib/payments/schedule";

describe("the sales demo can't touch real money", () => {
  it("is on only with the switch AND a Stripe TEST key", () => {
    expect(demoEnabled({ PAYMENTS_DEMO: "on", STRIPE_SECRET_KEY: "sk_test_abc" })).toBe(true);
    expect(demoEnabled({ PAYMENTS_DEMO: "on", STRIPE_SECRET_KEY: "rk_test_abc" })).toBe(true);
    // The day the live key goes in, every demo link dies by itself.
    expect(demoEnabled({ PAYMENTS_DEMO: "on", STRIPE_SECRET_KEY: "sk_live_abc", STRIPE_LIVE_ENABLED: "1" })).toBe(false);
    expect(demoEnabled({ PAYMENTS_DEMO: "on" })).toBe(false);
    expect(demoEnabled({ PAYMENTS_DEMO: "off", STRIPE_SECRET_KEY: "sk_test_abc" })).toBe(false);
    expect(demoEnabled({ STRIPE_SECRET_KEY: "sk_test_abc" })).toBe(false);
  });

  it("never mistakes a real Work Order for the demo one", () => {
    expect(isDemoWorkOrderId("0WOEm000008E87aOAC")).toBe(false);
    expect(isDemoWorkOrderId("0WO5f00000AbCdEFGH")).toBe(false);
    expect(isDemoWorkOrderId(null)).toBe(false);
    const id = newDemoWorkOrderId();
    expect(isDemoWorkOrderId(id)).toBe(true);
    expect(id).toMatch(/^0WODEMO[A-Za-z0-9]{11}$/);
    expect(newDemoWorkOrderId()).not.toBe(id);
  });
});

describe("the demo job", () => {
  it("is a $5,000 NY job, 30/40/30, nothing paid, Deposit due", () => {
    const id = newDemoWorkOrderId();
    const wo = demoWorkOrder(id);
    expect(wo.state).toBe("NY"); // NY: links allowed, 3% on credit allowed
    expect(wo.number).toBe(demoWorkOrderNumber(id));
    expect(DEMO_TERMS.reduce((s, t) => s + (t.amount ?? 0), 0)).toBe(wo.balanceOwed);
    const s = buildPaymentSchedule({ terms: wo.terms, balanceOwed: wo.balanceOwed });
    expect(s.warnings).toEqual([]);
    expect(s.milestones.map((m) => [m.label, m.amountCents, m.status])).toEqual([
      ["Deposit", 150000, "due"],
      ["Progress", 200000, "upcoming"],
      ["Final", 150000, "upcoming"],
    ]);
  });

  it("moves to Progress once the Deposit is paid online", () => {
    const wo = demoWorkOrder(newDemoWorkOrderId());
    const s = buildPaymentSchedule({ terms: wo.terms, balanceOwed: wo.balanceOwed, inFlightCents: 150000 });
    expect(s.milestones.map((m) => m.status)).toEqual(["processing", "due", "upcoming"]);
  });
});
