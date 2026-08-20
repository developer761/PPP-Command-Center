import { describe, it, expect } from "vitest";
import {
  DUNNING_PAST_DUE_DAYS,
  DUNNING_REDUN_DAYS,
  DUNNING_STALE_AFTER_DAYS,
  shouldEmailCustomerAboutOverdue,
} from "@/lib/commercial/cron/dunning-policy";
import {
  AIA_PAST_DUE_DAYS,
  AIA_REDUN_DAYS,
  AIA_STALE_AFTER_DAYS,
} from "@/lib/commercial/cron/aia-dunning";

/**
 * One chasing policy across both ledgers.
 *
 * A GC can be billed by invoice on one job and by AIA payment application on
 * another. Chasing those on two different clocks — a reminder at 15 days here
 * and 30 there, or one that stops and one that never does — is indefensible to
 * the person receiving both.
 *
 * The two crons used to carry their own copies of these numbers, which is why
 * they are now imported rather than repeated. These cases pin that they stayed
 * imported.
 */

describe("dunning policy", () => {
  it("is one set of numbers, not two", () => {
    expect(AIA_PAST_DUE_DAYS).toBe(DUNNING_PAST_DUE_DAYS);
    expect(AIA_REDUN_DAYS).toBe(DUNNING_REDUN_DAYS);
    expect(AIA_STALE_AFTER_DAYS).toBe(DUNNING_STALE_AFTER_DAYS);
  });

  it("stays quiet for the first fortnight", () => {
    expect(DUNNING_PAST_DUE_DAYS).toBe(15);
  });

  it("never mails the same document twice in a week", () => {
    expect(DUNNING_REDUN_DAYS).toBe(7);
  });

  // The ceiling. Without it the reminder loop mails a demand every week,
  // forever, on a bill whose likeliest explanation is our own record — a
  // payment never recorded, or a write-off nobody voided.
  describe("the staleness ceiling", () => {
    it("hands very old bills to a person instead of the customer", () => {
      expect(shouldEmailCustomerAboutOverdue(DUNNING_STALE_AFTER_DAYS)).toBe(true);
      expect(shouldEmailCustomerAboutOverdue(DUNNING_STALE_AFTER_DAYS + 1)).toBe(false);
      expect(shouldEmailCustomerAboutOverdue(400)).toBe(false);
    });

    it("leaves room for how slowly commercial GCs actually pay", () => {
      // 120 days past a 30-day due date is ~5 months from issue. Slow, but
      // ordinary on commercial work — the ceiling must not catch a normal job.
      expect(DUNNING_STALE_AFTER_DAYS).toBeGreaterThanOrEqual(90);
    });

    it("sits well above the first reminder, so the window is real", () => {
      expect(DUNNING_STALE_AFTER_DAYS).toBeGreaterThan(DUNNING_PAST_DUE_DAYS * 4);
    });
  });
});
