import { describe, it, expect } from "vitest";
import { aiaCollectedWithPayments } from "@/lib/commercial/aia/constants";

/**
 * THE BUG THIS PINS, 2026-09-24.
 *
 * Stephanie asked to record multiple payments against one AIA application. The
 * first version of that feature treated "this job has recorded payments" as
 * "stop inferring collected from the paid flag" — a replacement.
 *
 * On AIREF Building #1 that was destructive. Application 2 was marked paid
 * before payments existed, carrying $66,833.31. Recording $35,000 against
 * Application 3 replaced the inference with the recorded sum, so the job read
 * $35,000 collected: **collected went DOWN by $31,833.31 at the moment money
 * came in**, and $66,833.31 of received cash left the books.
 *
 * It was caught by running the real function against the real job, not by
 * reading the code — the types were fine and the tests were green.
 *
 * G702 line 6 is cumulative, so the two sources add along the application
 * ladder: the latest paid-but-unrecorded application's line 6 is a baseline
 * that already contains everything before it, and only payments on LATER
 * applications get added on top.
 */
describe("collected, when some payments are recorded and some are inferred", () => {
  it("adds recorded payments to the legacy paid baseline", () => {
    // The real numbers off AIREF Building #1.
    expect(
      aiaCollectedWithPayments({
        baselineCents: 6_683_331,
        recordedAfterBaselineCents: 3_500_000,
      })
    ).toBe(10_183_331);
  });

  it("never returns less than the baseline — the regression itself", () => {
    // Money arriving must never shrink the total. This is the assertion that
    // would have gone red on the first implementation.
    const baseline = 6_683_331;
    for (const recorded of [0, 1, 100, 3_500_000, 99_999_999]) {
      expect(
        aiaCollectedWithPayments({ baselineCents: baseline, recordedAfterBaselineCents: recorded })
      ).toBeGreaterThanOrEqual(baseline);
    }
  });

  it("is just the recorded sum when there is no legacy paid application", () => {
    expect(
      aiaCollectedWithPayments({ baselineCents: 0, recordedAfterBaselineCents: 3_500_000 })
    ).toBe(3_500_000);
  });

  it("is the baseline alone when nothing has been recorded after it", () => {
    expect(
      aiaCollectedWithPayments({ baselineCents: 6_683_331, recordedAfterBaselineCents: 0 })
    ).toBe(6_683_331);
  });

  it("treats a negative on either side as zero rather than eating real money", () => {
    // A negative cannot arrive from the DB (the CHECK forbids it) but a bad
    // subtraction upstream could, and silently reducing collected is the exact
    // failure this file exists for.
    expect(
      aiaCollectedWithPayments({ baselineCents: 6_683_331, recordedAfterBaselineCents: -5_000 })
    ).toBe(6_683_331);
    expect(
      aiaCollectedWithPayments({ baselineCents: -1, recordedAfterBaselineCents: 3_500_000 })
    ).toBe(3_500_000);
  });

  it("rounds to whole cents", () => {
    expect(
      aiaCollectedWithPayments({ baselineCents: 100.4, recordedAfterBaselineCents: 100.6 })
    ).toBe(201);
  });
});
