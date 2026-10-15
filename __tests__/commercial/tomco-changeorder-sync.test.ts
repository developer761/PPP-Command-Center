/**
 * What Salesforce should be holding for one change order — including the case
 * nobody will exercise by hand before it matters.
 *
 * A change order approved here is pushed into Salesforce as a `ChangeOrder__c`,
 * and `WorkOrder.TotalChangeOrder__c` rolls it into the number Katie runs the
 * company on. So the interesting direction is BACKWARDS: a change order that
 * was approved, pushed, and is then declined or deleted has money in her total
 * that this platform says is not owed. Nothing in the Command Center would ever
 * mention that job again, so if the reversal does not happen here it does not
 * happen at all.
 *
 * Measured against 18 live work orders on 2026-10-15: the rollup counts
 * approved statuses ONLY — a $800 `Denied` change order contributes $0 — and
 * `ChangeOrder__c` is not deletable. Which is why reversal is a status write,
 * and why these tests assert on the status rather than on a delete.
 */
import { describe, expect, it } from "vitest";
import {
  APPROVED_IN_SF,
  APPROVED_STATUS,
  changeOrderNeedsWrite,
  DENIED_STATUS,
  desiredSalesforceStatus,
  ROLLUP_TITLE,
  salesforceCounts,
} from "@/lib/salesforce/tomco-changeorder";
import { isSoldStatus } from "@/lib/salesforce/tomco-pairing";
import { needsRequeue } from "@/lib/salesforce/tomco-tick";
import { isQueueNotReady } from "@/lib/salesforce/tomco-queue";
import { dealStatusForOpportunity } from "@/lib/commercial/import/mapping";

describe("which Salesforce status this change order should carry", () => {
  it("approved here → a status Salesforce's rollup counts", () => {
    const status = desiredSalesforceStatus({ shouldCount: true });
    expect(status).toBe(APPROVED_STATUS);
    // The point of the status, asserted rather than assumed: it is one of the
    // ones the rollup adds up.
    expect(salesforceCounts(status)).toBe(true);
  });

  it("declined or deleted here → a status the rollup ignores", () => {
    const status = desiredSalesforceStatus({ shouldCount: false });
    expect(status).toBe(DENIED_STATUS);
    expect(salesforceCounts(status)).toBe(false);
  });
});

describe("the statuses Salesforce counts", () => {
  // From the org's own picklist on 2026-10-15. The three approved spellings
  // exist because the data was loaded by three different routes over the years.
  it.each(["Approved", "Approved-Auto", "Legacy Import (Approved)"])("counts %s", (s) => {
    expect(salesforceCounts(s)).toBe(true);
    expect(APPROVED_IN_SF).toContain(s);
  });

  it.each(["Denied", "New", "Pending Approval", "Pending", "", null, undefined])("does not count %s", (s) => {
    expect(salesforceCounts(s)).toBe(false);
  });
});

describe("whether Salesforce needs writing to at all", () => {
  // An update that changes nothing is not free: it still enters every flow on
  // the object, including the unfiltered quota-points one.
  it("leaves an approved record at the right amount alone", () => {
    expect(
      changeOrderNeedsWrite({ status: "Approved", costChange: 550 }, { amountCents: 55_000, shouldCount: true }),
    ).toBe(false);
  });

  it("leaves a record alone whichever approved spelling it carries", () => {
    expect(
      changeOrderNeedsWrite({ status: "Approved-Auto", costChange: 550 }, { amountCents: 55_000, shouldCount: true }),
    ).toBe(false);
  });

  it("writes when Salesforce is not counting money this platform says is owed", () => {
    expect(
      changeOrderNeedsWrite({ status: "Denied", costChange: 550 }, { amountCents: 55_000, shouldCount: true }),
    ).toBe(true);
  });

  /** The reversal. This is the test the whole file exists for. */
  it("writes when Salesforce is still counting money that was declined here", () => {
    expect(
      changeOrderNeedsWrite({ status: "Approved", costChange: 550 }, { amountCents: 55_000, shouldCount: false }),
    ).toBe(true);
  });

  it("writes when the amount disagrees to the cent", () => {
    expect(
      changeOrderNeedsWrite({ status: "Approved", costChange: 550.01 }, { amountCents: 55_000, shouldCount: true }),
    ).toBe(true);
  });

  it("does not re-write a denied record just because the amounts differ", () => {
    // The rollup ignores it either way, so a write here would re-enter every
    // flow on the object to change a number nothing reads.
    expect(
      changeOrderNeedsWrite({ status: "Denied", costChange: 0 }, { amountCents: 55_000, shouldCount: false }),
    ).toBe(false);
  });

  it("writes when Salesforce has no status at all", () => {
    expect(
      changeOrderNeedsWrite({ status: null, costChange: null }, { amountCents: 55_000, shouldCount: true }),
    ).toBe(true);
  });
});

describe("the migrated rollup rows are never pushed", () => {
  /*
   * 18 of the 23 approved change orders here are titled "Approved change
   * orders" — rows the importer created to carry a Salesforce TOTAL, not real
   * change orders. LMJ Cipla's single $31,127.09 row stands for SEVEN
   * Salesforce records; across the book they carry ~$176,000 that Salesforce
   * already holds.
   */
  it.each(["Approved change orders", "approved change orders", "APPROVED CHANGE ORDERS"])("recognises %s", (t) => {
    expect(ROLLUP_TITLE.test(t)).toBe(true);
  });

  it("does not catch a real change order whose title mentions one", () => {
    // The match is anchored, so a real change order a person happened to title
    // "Approved change orders for the lobby" is still pushed.
    expect(ROLLUP_TITLE.test("Approved change orders for the lobby")).toBe(false);
    expect(ROLLUP_TITLE.test("Drip Caps")).toBe(false);
  });
});

describe("which deals count as sold", () => {
  /*
   * The gate on the sale half of the queue. `pre_sale_closed` is the one that
   * needs the sub-status: the same status covers won AND lost, and queueing a
   * lost deal would put a Closed Won in Salesforce for a job Tomco did not get.
   */
  it.each(["pre_construction", "in_progress", "billing", "post_sale_closed"])("%s is sold", (s) => {
    expect(isSoldStatus(s, null)).toBe(true);
  });

  it("pre_sale_closed is sold only when it was won", () => {
    expect(isSoldStatus("pre_sale_closed", "won")).toBe(true);
    expect(isSoldStatus("pre_sale_closed", "lost")).toBe(false);
    expect(isSoldStatus("pre_sale_closed", null)).toBe(false);
  });

  it.each(["lead", "qualified", "proposal", "negotiation", "", null])("%s is not sold", (s) => {
    expect(isSoldStatus(s, "won")).toBe(false);
  });
});

describe("the nightly sweep's re-queue rule", () => {
  /*
   * The backstop under the moment-of-change hooks. `queueForWriteBack` never
   * throws — a job must not fail to be sold because a bookkeeping row could not
   * be written — which means it is allowed to silently not happen, and this is
   * what notices.
   */
  it("queues something that has never been queued", () => {
    expect(needsRequeue(null, "2026-10-15T10:00:00Z")).toBe(true);
    // Including one with no updated_at at all: a sale with no entry is unsynced
    // whatever its timestamps say.
    expect(needsRequeue(null, null)).toBe(true);
  });

  it("leaves a pending entry alone — the tick owns it", () => {
    expect(needsRequeue({ doneAt: null }, "2026-10-15T10:00:00Z")).toBe(false);
  });

  it("queues again when the deal changed after the last write", () => {
    expect(needsRequeue({ doneAt: "2026-10-15T10:00:00Z" }, "2026-10-15T11:00:00Z")).toBe(true);
  });

  it("does not queue again when nothing has changed since the last write", () => {
    expect(needsRequeue({ doneAt: "2026-10-15T11:00:00Z" }, "2026-10-15T10:00:00Z")).toBe(false);
    // The equal case is "the write is the most recent thing that happened".
    expect(needsRequeue({ doneAt: "2026-10-15T10:00:00Z" }, "2026-10-15T10:00:00Z")).toBe(false);
  });
});

describe("where a Salesforce opportunity sits on our ladder", () => {
  /*
   * The rule that nearly un-won a $30,000 job. `openBidStatus` is for OPEN
   * bids and its default arm is `qualifying/rfp`; the importer fell through to
   * it whenever Salesforce had no work order, so a Closed Won opportunity with
   * no work order was written back as an unqualified lead. Five Tomco deals
   * were in that state on 2026-10-15, and MotorMindz ($30,000) was the one the
   * edit guard did not protect.
   */
  it("a won opportunity with no work order stays won", () => {
    expect(dealStatusForOpportunity({ workOrderStatus: null, isWon: true, stageName: "Closed Won" }))
      .toEqual({ status: "pre_sale_closed", subStatus: "won" });
  });

  it("a won opportunity is won whatever its stage text says", () => {
    // The stage is not consulted once IsWon is true — a renamed or unfamiliar
    // stage must not be able to reopen a closed sale.
    expect(dealStatusForOpportunity({ workOrderStatus: null, isWon: true, stageName: "Something Nobody Mapped" }))
      .toEqual({ status: "pre_sale_closed", subStatus: "won" });
  });

  it("an open bid still reads from its stage", () => {
    expect(dealStatusForOpportunity({ workOrderStatus: null, isWon: false, stageName: "Estimate Sent" }))
      .toEqual({ status: "proposal", subStatus: "sent" });
    expect(dealStatusForOpportunity({ workOrderStatus: null, isWon: false, stageName: "Opportunity Assigned" }))
      .toEqual({ status: "estimating", subStatus: "estimating" });
  });

  it("a work order outranks both — it is a real job with crew on it", () => {
    expect(dealStatusForOpportunity({ workOrderStatus: "Work In Progress", isWon: true, stageName: "Closed Won" }))
      .toEqual({ status: "in_progress", subStatus: "wip_on_site" });
  });

  it("a work order whose status maps to nothing returns nothing, so the caller can skip", () => {
    // This is what makes a freshly synced work order harmless: it arrives as
    // New or Ready to Schedule, the importer skips the deal rather than
    // guessing, and the platform's own status stands.
    // Empty string, not undefined — the importer's guard is `if (!st.status)`,
    // so what matters is that it is FALSY. Asserted as the caller reads it.
    for (const woStatus of ["New", "Ready to Schedule", "Something Salesforce Renamed"]) {
      const st = dealStatusForOpportunity({ workOrderStatus: woStatus, isWon: true, stageName: "Closed Won" });
      expect(st.status, `${woStatus} should not map to a status`).toBeFalsy();
    }
  });
});

describe("the window between deploying and running the migration", () => {
  /*
   * This repo applies migrations by hand, so there is always a gap between the
   * code going live and the column existing. The per-minute cron sits in that
   * gap: without this, `claimPending` throws on a missing column and the route
   * logs a 500 every sixty seconds until somebody runs the SQL — which is
   * exactly the noise that teaches people to ignore a real failure.
   */
  it("recognises a missing table", () => {
    expect(isQueueNotReady('relation "public.commercial_tomco_writeback_queue" does not exist')).toBe(true);
    expect(isQueueNotReady("Could not find the table 'public.commercial_tomco_writeback_queue' in the schema cache")).toBe(true);
  });

  it("recognises a missing column, which names the column and not the table", () => {
    expect(isQueueNotReady("Could not find the 'claimed_at' column of 'commercial_tomco_writeback_queue' in the schema cache")).toBe(true);
    expect(isQueueNotReady('column commercial_tomco_writeback_queue.claimed_at does not exist')).toBe(true);
    expect(isQueueNotReady("Could not find the 'verify_failed_at' column in the schema cache")).toBe(true);
  });

  it("does NOT swallow a real failure", () => {
    // The point of the narrow match. A permission problem, an RLS refusal or a
    // dead connection must still throw — treating those as "not ready yet"
    // would make the sync silently stop with everything looking fine.
    expect(isQueueNotReady("permission denied for table commercial_tomco_writeback_queue")).toBe(false);
    expect(isQueueNotReady("new row violates row-level security policy")).toBe(false);
    expect(isQueueNotReady("fetch failed")).toBe(false);
    expect(isQueueNotReady("timeout exceeded")).toBe(false);
  });
});
