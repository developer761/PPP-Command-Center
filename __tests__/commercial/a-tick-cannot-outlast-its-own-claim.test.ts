/**
 * Two write-back ticks cannot work the same queue entry — and the only reason
 * that is true lives in a different file from the thing that guarantees it.
 *
 * `claimPending` takes an entry with a compare-and-swap on `claimed_at`, and
 * `CLAIM_STALE_MS` (ten minutes) lets another tick take it back when the
 * holder evidently died. A LIVE holder must therefore never still be working
 * an entry when its own claim goes stale. Nothing enforced that. It happened
 * to hold because `app/api/cron/tomco-writeback/route.ts` declares
 * `maxDuration = 300` and Vercel kills the function there — 300s under a
 * 600s window, in two files, with no comment linking them and no assertion
 * anywhere.
 *
 * Raise `maxDuration` to 900 for a deep queue and the claim expires under a
 * tick that is still running. A second tick claims the row, both reach
 * `syncChangeOrder`, both find no link and no matching amount, and both create
 * a `ChangeOrder__c` for the same money. `ChangeOrder__c` has no unique
 * external id, so Salesforce accepts the second one and
 * `WorkOrder.TotalChangeOrder__c` — the number Katie runs the company on —
 * doubles. That is the documented reason the atomic claim exists at all; this
 * is the rule that keeps it working.
 *
 * ASSERTED ON THE VALUE THE PLATFORM USES, not on the text of the file: the
 * route's `maxDuration` export is read by importing it, so a rename, a
 * computed value or a move cannot make this test quietly stop looking.
 */
import { describe, expect, it } from "vitest";
import { CLAIM_STALE_MS, MAX_TICK_SECONDS } from "@/lib/salesforce/tomco-queue";
import { maxDuration } from "@/app/api/cron/tomco-writeback/route";

describe("the cron route's ceiling and the claim's staleness window", () => {
  it("the route really does declare a ceiling", () => {
    // Without this the rest is vacuous: an undefined maxDuration is NaN-safe
    // in a `<=` comparison in neither direction a reader would expect, and
    // Vercel's own default (which is not 300) would be in force.
    expect(typeof maxDuration).toBe("number");
    expect(Number.isFinite(maxDuration)).toBe(true);
  });

  it("a tick is given at most half the window before its claim can go stale", () => {
    expect(
      maxDuration,
      `the tick may run ${maxDuration}s but its claim goes stale after ${CLAIM_STALE_MS / 1000}s — ` +
        `two ticks can work the same entry and create two ChangeOrder__c records for one change order`,
    ).toBeLessThanOrEqual(MAX_TICK_SECONDS);
  });

  it("the budget is derived from the window, so moving one moves the other", () => {
    // MAX_TICK_SECONDS is not a second hardcoded number to drift from the
    // first — it is CLAIM_STALE_MS halved. Shortening the staleness window
    // tightens the route's ceiling automatically.
    expect(MAX_TICK_SECONDS * 2 * 1000).toBe(CLAIM_STALE_MS);
    // And the half that is NOT the tick's is real slack: time for the platform
    // to actually stop the function, for clock skew between the two writers,
    // and for the round trip that releases the claim.
    expect(maxDuration * 1000).toBeLessThan(CLAIM_STALE_MS);
  });
});
