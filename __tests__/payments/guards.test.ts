import { describe, expect, it } from "vitest";
import { readPaymentsConfig, shouldWriteToSalesforce } from "@/lib/payments/config";
import { isForwardMove, statusFromPaymentIntent, statusFromSession } from "@/lib/payments/session-status";
import { buildSfTransaction, stripeDepositReference } from "@/lib/payments/sf-transaction";

describe("readPaymentsConfig — nothing real happens by default", () => {
  it("everything is off with no env", () => {
    const c = readPaymentsConfig({});
    expect(c.stripeBlockedReason).toMatch(/not set/);
    expect(c.publicPages).toBe(false);
    expect(c.sfWritebackOn).toBe(false);
    expect(c.webhookSecretPresent).toBe(false);
  });

  it("a test key is usable", () => {
    const c = readPaymentsConfig({ STRIPE_SECRET_KEY: "sk_test_abc" });
    expect(c.stripeMode).toBe("test");
    expect(c.stripeBlockedReason).toBeNull();
  });

  it("a LIVE key is refused unless live is explicitly switched on", () => {
    expect(readPaymentsConfig({ STRIPE_SECRET_KEY: "sk_live_abc" }).stripeBlockedReason).toMatch(/LIVE key/);
    expect(readPaymentsConfig({ STRIPE_SECRET_KEY: "rk_live_abc" }).stripeBlockedReason).toMatch(/LIVE key/);
    expect(readPaymentsConfig({ STRIPE_SECRET_KEY: "sk_live_abc", STRIPE_LIVE_ENABLED: "true" }).stripeBlockedReason).toMatch(
      /LIVE key/,
    );
    expect(readPaymentsConfig({ STRIPE_SECRET_KEY: "sk_live_abc", STRIPE_LIVE_ENABLED: "1" }).stripeBlockedReason).toBeNull();
  });

  it("a publishable key pasted by mistake is refused", () => {
    expect(readPaymentsConfig({ STRIPE_SECRET_KEY: "pk_test_abc" }).stripeBlockedReason).toMatch(/not a Stripe secret/);
  });

  it("pages are public only on exactly PAYMENTS_PUBLIC=1", () => {
    expect(readPaymentsConfig({ PAYMENTS_PUBLIC: "true" }).publicPages).toBe(false);
    expect(readPaymentsConfig({ PAYMENTS_PUBLIC: "1" }).publicPages).toBe(true);
    // A dashboard paste with stray whitespace still counts; other words don't.
    expect(readPaymentsConfig({ PAYMENTS_PUBLIC: " 1\n" }).publicPages).toBe(true);
    expect(readPaymentsConfig({ PAYMENTS_PUBLIC: "yes" }).publicPages).toBe(false);
  });

  it("SANDBOX: only test payments are written, real money never", () => {
    const sb = readPaymentsConfig({ PAYMENTS_SF_WRITEBACK: "on", PAYMENTS_SF_ORG: "sandbox" });
    expect(sb.sfOrg).toBe("sandbox");
    expect(shouldWriteToSalesforce(sb, false)).toBe(true);
    expect(shouldWriteToSalesforce(sb, true)).toBe(false);
    expect(shouldWriteToSalesforce(readPaymentsConfig({ PAYMENTS_SF_ORG: "sandbox" }), false)).toBe(false);
  });

  it("anything but exactly 'sandbox' is production", () => {
    expect(readPaymentsConfig({ PAYMENTS_SF_ORG: "Sandbox" }).sfOrg).toBe("production");
    expect(readPaymentsConfig({ PAYMENTS_SF_ORG: "dev" }).sfOrg).toBe("production");
    expect(readPaymentsConfig({}).sfOrg).toBe("production");
  });

  it("a TEST payment is never written to Salesforce, even with write-back on", () => {
    const on = readPaymentsConfig({ PAYMENTS_SF_WRITEBACK: "on" });
    expect(shouldWriteToSalesforce(on, false)).toBe(false);
    expect(shouldWriteToSalesforce(on, true)).toBe(true);
    expect(shouldWriteToSalesforce(readPaymentsConfig({}), true)).toBe(false);
  });
});

describe("statusFromSession — ACH is not money until it clears", () => {
  it("card: complete + paid = succeeded", () => {
    expect(statusFromSession({ status: "complete", payment_status: "paid" }, "checkout.session.completed")).toBe("succeeded");
  });

  it("ACH: complete + unpaid = processing, NOT succeeded", () => {
    expect(statusFromSession({ status: "complete", payment_status: "unpaid" }, "checkout.session.completed")).toBe(
      "processing",
    );
  });

  it("ACH clears → succeeded; ACH bounces → failed", () => {
    expect(
      statusFromSession({ status: "complete", payment_status: "paid" }, "checkout.session.async_payment_succeeded"),
    ).toBe("succeeded");
    expect(
      statusFromSession({ status: "complete", payment_status: "unpaid" }, "checkout.session.async_payment_failed"),
    ).toBe("failed");
  });

  it("abandoned checkout expires", () => {
    expect(statusFromSession({ status: "expired", payment_status: "unpaid" }, "checkout.session.expired")).toBe("expired");
    expect(statusFromSession({ status: "open", payment_status: "unpaid" })).toBe("open");
  });
});

describe("isForwardMove — a late or repeated event never undoes a payment", () => {
  it.each([
    ["open", "processing", true],
    ["open", "succeeded", true],
    ["processing", "succeeded", true],
    ["processing", "failed", true],
    ["succeeded", "processing", false],
    ["succeeded", "failed", false],
    ["succeeded", "succeeded", false],
    ["succeeded", "expired", false],
    ["failed", "succeeded", true],
    ["refunded", "succeeded", false],
  ])("%s → %s is %s", (from, to, ok) => {
    expect(isForwardMove(from, to)).toBe(ok);
  });
});

describe("buildSfTransaction", () => {
  const base = {
    recordTypeId: "0126g000000HB7zAAG",
    workOrderId: "0WOWj000007cfxNOAQ",
    workOrderNumber: "00313399",
    milestoneLabel: "Deposit",
    baseCents: 56615,
    paymentIntentId: "pi_3Q0abcdefghijklmnopqrstu",
    paidDateEt: "2026-09-23",
  };

  it("books the BASE amount, never base + fee, so BalanceOwed doesn't go negative", () => {
    const f = buildSfTransaction({ ...base, method: "card", feeCents: 1698 });
    expect(f.Amount__c).toBe(566.15);
    expect(f.Description__c).toMatch(/card fee \$16\.98/);
  });

  it("follows finance's conventions: ST+MMDD deposit code, deposit date, Deposited when from a payout", () => {
    const f = buildSfTransaction({ ...base, method: "ach", feeCents: 0, paidDateEt: "2026-10-08", fromPayout: true });
    expect(f).toMatchObject({
      RecordTypeId: "0126g000000HB7zAAG",
      WorkOrder__c: "0WOWj000007cfxNOAQ",
      Method__c: "Stripe",
      Date__c: "2026-10-08",
      // What production's real Stripe Payment Ins on 10/8 carry.
      ReferenceId__c: "ST1008",
      Deposited__c: true,
    });
    expect(f.Description__c).not.toMatch(/fee/);
  });

  it("booked early by an admin (no payout yet): not Deposited", () => {
    expect(buildSfTransaction({ ...base, method: "ach", feeCents: 0 }).Deposited__c).toBe(false);
  });

  it.each([
    ["2026-10-08", "ST1008"],
    ["2026-01-05", "ST0105"],
    ["2026-12-31", "ST1231"],
  ])("stripeDepositReference(%s) = %s", (d, ref) => expect(stripeDepositReference(d)).toBe(ref));

  it("Description starts 'Stripe pi_…' — the convention Katie's daily job dedupes on", () => {
    const f = buildSfTransaction({ ...base, method: "ach", feeCents: 0 });
    expect(String(f.Description__c).startsWith("Stripe pi_3Q0abcdefghijklmnopqrstu")).toBe(true);
  });

  it("links the Opportunity when the Work Order has one, and leaves the field off when not", () => {
    expect(buildSfTransaction({ ...base, method: "ach", feeCents: 0, opportunityId: "006Wj000001abcDEF" }).Opportunity__c).toBe(
      "006Wj000001abcDEF",
    );
    expect("Opportunity__c" in buildSfTransaction({ ...base, method: "ach", feeCents: 0, opportunityId: null })).toBe(false);
  });

  it("names the card type, so a fee (or none) explains itself", () => {
    expect(buildSfTransaction({ ...base, method: "card", cardFunding: "debit", feeCents: 0 }).Description__c).toMatch(
      /^Stripe pi_3Q0abcdefghijklmnopqrstu · Online debit card payment · Deposit/,
    );
    expect(buildSfTransaction({ ...base, method: "card", cardFunding: "credit", feeCents: 1698 }).Description__c).toMatch(
      /Online credit card payment .* card fee \$16\.98/,
    );
    expect(buildSfTransaction({ ...base, method: "card", cardFunding: "unknown", feeCents: 0 }).Description__c).toMatch(
      /^Stripe pi_\w+ · Online card payment/,
    );
  });

  it("fits Salesforce's field lengths (ReferenceId 50, Description 255)", () => {
    const f = buildSfTransaction({
      ...base,
      method: "card",
      feeCents: 1,
      paymentIntentId: "pi_" + "x".repeat(80),
      milestoneLabel: "L".repeat(400),
    });
    expect(String(f.ReferenceId__c).length).toBeLessThanOrEqual(50);
    expect(String(f.Description__c).length).toBe(255);
  });
});

describe("card form keys — the browser key must match the server key's mode", () => {
  it("test secret + test publishable = card payments available", () => {
    const c = readPaymentsConfig({ STRIPE_SECRET_KEY: "sk_test_a", NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_b" });
    expect(c.cardBlockedReason).toBeNull();
    expect(c.publishableKey).toBe("pk_test_b");
  });

  it("missing publishable key blocks cards but not bank payments", () => {
    const c = readPaymentsConfig({ STRIPE_SECRET_KEY: "sk_test_a" });
    expect(c.cardBlockedReason).toMatch(/PUBLISHABLE_KEY is not set/);
    expect(c.stripeBlockedReason).toBeNull();
  });

  it("a live publishable key beside a test secret key is refused", () => {
    const c = readPaymentsConfig({ STRIPE_SECRET_KEY: "sk_test_a", NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_live_b" });
    expect(c.cardBlockedReason).toMatch(/must match/);
  });

  it("a secret key pasted into the publishable slot is refused", () => {
    const c = readPaymentsConfig({ STRIPE_SECRET_KEY: "sk_test_a", NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "sk_test_a" });
    expect(c.cardBlockedReason).toMatch(/not a publishable key/);
  });

  it("a blocked secret key blocks cards too", () => {
    const c = readPaymentsConfig({ STRIPE_SECRET_KEY: "sk_live_a", NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_live_b" });
    expect(c.cardBlockedReason).toMatch(/LIVE key/);
  });
});

describe("statusFromPaymentIntent", () => {
  it.each([
    ["succeeded", "succeeded"],
    ["processing", "processing"],
    ["requires_action", "open"],
    ["requires_confirmation", "open"],
    ["requires_payment_method", "failed"],
    ["canceled", "failed"],
  ])("%s → %s", (pi, ours) => expect(statusFromPaymentIntent(pi)).toBe(ours));
});
