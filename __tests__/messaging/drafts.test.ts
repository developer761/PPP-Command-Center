import { describe, it, expect } from "vitest";
import {
  isStale, orderQueue, wasEdited, reviewReasonText, refusalText, waitingSeconds,
  type DraftForReview,
} from "@/lib/messaging/drafts";

const d = (o: Partial<DraftForReview>): DraftForReview => ({
  id: "1", conversationId: "c1", workspaceName: "NY LI Nassau Leads",
  customerPhone: "+15165551234", customerName: null,
  intent: "ask_address", confidence: 0.9, reasoning: null,
  body: "What's the address for the project?",
  reviewReason: "autosend_off",
  sendError: null,
  createdAt: "2026-09-10T10:00:00Z",
  answersMessageId: "m1", latestInboundId: "m1", latestInboundAt: "2026-09-10T09:59:00Z",
  ...o,
});

describe("a draft that has been overtaken", () => {
  /**
   * The failure this catches: the customer writes again while a draft waits,
   * and sending it answers a question they have already moved past. That is
   * the "nobody is reading" failure Kate graded conversations down for.
   */
  it("is stale when the customer has written since", () => {
    expect(isStale(d({ answersMessageId: "m1", latestInboundId: "m2" }))).toBe(true);
  });

  it("is not stale when nothing has arrived since", () => {
    expect(isStale(d({ answersMessageId: "m1", latestInboundId: "m1" }))).toBe(false);
  });

  it("is not stale for an opening message with no inbound at all", () => {
    expect(isStale(d({ answersMessageId: null, latestInboundId: null }))).toBe(false);
  });

  /** An opening draft written before they ever replied, and then they did. */
  it("is stale when an opening draft has been overtaken by a reply", () => {
    expect(isStale(d({ answersMessageId: null, latestInboundId: "m9" }))).toBe(true);
  });
});

describe("the order of the queue", () => {
  it("puts the longest waiting first", () => {
    const q = orderQueue([
      d({ id: "new", createdAt: "2026-09-10T12:00:00Z" }),
      d({ id: "old", createdAt: "2026-09-10T08:00:00Z" }),
    ]);
    expect(q.map((x) => x.id)).toEqual(["old", "new"]);
  });

  /** Stale ones need a decision that is not "send", so they come first. */
  it("puts stale ones ahead even when they are newer", () => {
    const q = orderQueue([
      d({ id: "old", createdAt: "2026-09-10T08:00:00Z" }),
      d({ id: "stale", createdAt: "2026-09-10T12:00:00Z", latestInboundId: "m2" }),
    ]);
    expect(q[0].id).toBe("stale");
  });

  it("does not lose anything", () => {
    const q = orderQueue([d({ id: "a" }), d({ id: "b" }), d({ id: "c" })]);
    expect(q).toHaveLength(3);
  });

  it("counts the wait in whole seconds", () => {
    expect(waitingSeconds(d({ createdAt: "2026-09-10T10:00:00Z" }), new Date("2026-09-10T10:05:00Z"))).toBe(300);
    expect(waitingSeconds(d({ createdAt: "2026-09-10T10:05:00Z" }), new Date("2026-09-10T10:00:00Z"))).toBe(0);
  });
});

describe("did the reviewer actually change it", () => {
  it("ignores whitespace nobody meant to add", () => {
    expect(wasEdited("Hello there", "  Hello   there  ")).toBe(false);
    expect(wasEdited("Hello there", "Hello there\n")).toBe(false);
  });

  it("catches a real rewrite", () => {
    // This is the training signal: what it said, and what it should have said.
    expect(wasEdited("What's the address?", "Is 12 Oak St still right?")).toBe(true);
  });

  it("catches a single changed word", () => {
    expect(wasEdited("What's the address?", "What's the postcode?")).toBe(true);
  });
});

describe("wording a person can act on", () => {
  it("says why each draft is waiting", () => {
    expect(reviewReasonText("low_confidence")).toMatch(/not confident/i);
    expect(reviewReasonText("escalated")).toMatch(/asked for a person/i);
    expect(reviewReasonText("autosend_off")).toMatch(/while we are testing/i);
    expect(reviewReasonText("negative_reaction")).toMatch(/reacted badly/i);
    expect(reviewReasonText("first_contact")).toMatch(/first thing/i);
  });

  it("explains a refusal without making the reviewer read a log", () => {
    expect(refusalText("suppressed")).toMatch(/opted out/i);
    expect(refusalText("quiet_hours")).toMatch(/sending hours/i);
    expect(refusalText("daily_cap")).toMatch(/maximum messages/i);
    // Even one nobody thought of still reads as a sentence.
    expect(refusalText("something_new")).toMatch(/refused/i);
  });
});

/**
 * THE GATE'S REASON WAS WRITTEN IN THREE PLACES AND READ IN NONE.
 *
 * sms_drafts.send_error is set when an autosend is refused and when somebody's
 * "Send it" is refused — and pendingDrafts selected every column except that
 * one. So a draft for a customer who has opted out arrived in the queue
 * looking like any other, under the benign line "Nothing sends without you
 * while we are testing", and the only way to find out was to press Send and be
 * refused. For a suppressed number that is a person trying repeatedly to text
 * somebody they are not allowed to text, with the answer already on file.
 */
describe("a draft the gate has already refused says so", () => {
  it("carries the reason on the draft itself", () => {
    const draft = d({ sendError: "suppressed" });
    expect(draft.sendError).toBe("suppressed");
    expect(refusalText(draft.sendError!)).toMatch(/opted out/i);
  });

  it("every refusal the gate can give has a sentence for a person", () => {
    // A code with no wording would render as nothing at all on the card.
    for (const reason of [
      "suppressed", "quiet_hours", "weekend", "holiday", "daily_cap",
      "no_workspace_number", "empty_body", "too_long", "office_closed",
      "suppression_list_empty", "unresolved_merge_field",
    ]) {
      expect(refusalText(reason), reason).toBeTruthy();
      expect(refusalText(reason).length, reason).toBeGreaterThan(10);
    }
  });
});
