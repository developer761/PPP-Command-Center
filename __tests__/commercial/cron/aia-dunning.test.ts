import { describe, it, expect } from "vitest";
import {
  shouldChaseAiaApplication,
  AIA_PAST_DUE_DAYS,
  AIA_REDUN_DAYS,
} from "@/lib/commercial/cron/aia-dunning";

/**
 * Whether to email a GC about a late payment application.
 *
 * Every clause here is a way to get that wrong in front of a customer, so each
 * gets a case: chasing retainage, chasing an amount with no date behind it,
 * chasing twice in a week, or chasing a bill that has since been deleted.
 */

const NOW = Date.parse("2026-08-19T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function app(over: Partial<Parameters<typeof shouldChaseAiaApplication>[0]> = {}) {
  return {
    dueNowCents: 40_000_00,
    dueAtIso: daysAgo(20),
    lastDunningAt: null,
    status: "submitted",
    deletedAt: null,
    ...over,
  };
}

describe("shouldChaseAiaApplication", () => {
  it("chases an issued application past the threshold", () => {
    expect(shouldChaseAiaApplication(app(), 20, NOW)).toBe(true);
  });

  it("waits until the threshold", () => {
    expect(shouldChaseAiaApplication(app(), AIA_PAST_DUE_DAYS - 1, NOW)).toBe(false);
    expect(shouldChaseAiaApplication(app(), AIA_PAST_DUE_DAYS, NOW)).toBe(true);
  });

  it("never chases a draft — it was never certified", () => {
    expect(shouldChaseAiaApplication(app({ status: "draft" }), 60, NOW)).toBe(false);
  });

  it("chases a 'paid' application only while money is still on it", () => {
    // The status marks the last CERTIFIED-paid application; the ladder can still
    // leave a balance if a later period was certified after it.
    expect(shouldChaseAiaApplication(app({ status: "paid" }), 60, NOW)).toBe(true);
    expect(shouldChaseAiaApplication(app({ status: "paid", dueNowCents: 0 }), 60, NOW)).toBe(false);
  });

  it("never chases when nothing is currently payable", () => {
    // dueNowCents is earned-less-retainage minus collected. A job whose only
    // outstanding money is RETAINAGE lands here — and retainage is held to
    // close-out under the contract, not late.
    expect(shouldChaseAiaApplication(app({ dueNowCents: 0 }), 90, NOW)).toBe(false);
    expect(shouldChaseAiaApplication(app({ dueNowCents: -5_00 }), 90, NOW)).toBe(false);
  });

  it("never chases an amount with no issue date behind it", () => {
    // An undated demand is one the GC disputes.
    expect(shouldChaseAiaApplication(app({ dueAtIso: null }), 90, NOW)).toBe(false);
  });

  it("never chases a deleted application", () => {
    expect(shouldChaseAiaApplication(app({ deletedAt: daysAgo(1) }), 90, NOW)).toBe(false);
  });

  it("holds off inside the weekly window, and resumes after it", () => {
    expect(shouldChaseAiaApplication(app({ lastDunningAt: daysAgo(1) }), 60, NOW)).toBe(false);
    expect(
      shouldChaseAiaApplication(app({ lastDunningAt: daysAgo(AIA_REDUN_DAYS - 1) }), 60, NOW)
    ).toBe(false);
    expect(
      shouldChaseAiaApplication(app({ lastDunningAt: daysAgo(AIA_REDUN_DAYS + 1) }), 60, NOW)
    ).toBe(true);
  });

  it("an unreadable marker doesn't silence the chase forever", () => {
    expect(shouldChaseAiaApplication(app({ lastDunningAt: "not-a-date" }), 60, NOW)).toBe(true);
  });

  it("matches the invoice dunning contract it mirrors", () => {
    // Same 15-day threshold and same weekly re-send as `invoice-dunning.ts`.
    // Two ledgers chased on different clocks would be indefensible to a GC
    // being billed both ways on different jobs.
    expect(AIA_PAST_DUE_DAYS).toBe(15);
    expect(AIA_REDUN_DAYS).toBe(7);
  });
});
