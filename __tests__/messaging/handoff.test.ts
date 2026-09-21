import { describe, it, expect } from "vitest";
import fs from "node:fs";
import {
  TAKEOVER_REASONS, takeoverReasonLabel, takeoverReasonFor,
  isTakeoverReason, stateOnRelease, heldFor, latestInboundIsAnswered,
} from "@/lib/messaging/handoff";

describe("takeover reasons match the database", () => {
  /**
   * The list lives in two places: this app, and the CHECK constraint migration
   * 193 put on sms_conversations. A value here that is not there reaches the
   * screen as a Postgres constraint-violation string, which is the worst
   * possible way to learn about it. So the two are compared.
   */
  it("the code list is exactly the constraint list", () => {
    const sql = fs.readFileSync("supabase/migrations/193_conversation_funnel.sql", "utf8");
    const block = sql.slice(sql.indexOf("takeover_reason IN ("));
    const fromSql = [...block.slice(0, block.indexOf(")")).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

    expect(fromSql.length).toBeGreaterThan(5);
    expect([...TAKEOVER_REASONS].sort()).toEqual([...fromSql].sort());
  });

  it("every reason has words a person would use", () => {
    for (const r of TAKEOVER_REASONS) {
      const label = takeoverReasonLabel(r);
      expect(label, r).toBeTruthy();
      // Not the raw key dressed up.
      expect(label).not.toContain("_");
    }
  });

  it("rejects anything not on the list", () => {
    expect(isTakeoverReason("customer_asked_human")).toBe(true);
    expect(isTakeoverReason("because_i_felt_like_it")).toBe(false);
    expect(isTakeoverReason("")).toBe(false);
  });
});

describe("why the bot handed over", () => {
  it("below the threshold is low confidence", () => {
    expect(takeoverReasonFor({ intent: "ask_address", confidence: 0.6, threshold: 0.95 }))
      .toBe("low_confidence");
  });

  it("a deliberate escalation is not dressed up as low confidence", () => {
    // It escalated on purpose AND was certain. Calling that "the bot was
    // unsure" would put a wrong reason in the column reporting counts.
    expect(takeoverReasonFor({ intent: "escalate", confidence: 0.99, threshold: 0.95 }))
      .toBe("other");
  });

  it("a confident ordinary turn is not attributed either", () => {
    expect(takeoverReasonFor({ intent: "ask_address", confidence: 0.99, threshold: 0.95 }))
      .toBe("other");
  });

  it("the threshold is the workspace's, not a constant", () => {
    // 0.9 passes a workspace set to 0.85 and fails one set to 0.95.
    expect(takeoverReasonFor({ intent: "ask_address", confidence: 0.9, threshold: 0.85 })).toBe("other");
    expect(takeoverReasonFor({ intent: "ask_address", confidence: 0.9, threshold: 0.95 })).toBe("low_confidence");
  });

  it("produces only values the database accepts", () => {
    for (const c of [0, 0.5, 0.94, 0.95, 1]) {
      for (const intent of ["escalate", "ask_address", "acknowledge"]) {
        expect(isTakeoverReason(takeoverReasonFor({ intent, confidence: c, threshold: 0.95 }))).toBe(true);
      }
    }
  });
});

describe("handing it back to the bot", () => {
  it("goes to awaiting_customer when the human already replied", () => {
    // The customer owes us a message. Returning to ai_active would queue a
    // second reply to something that has been answered.
    expect(stateOnRelease("outbound")).toBe("awaiting_customer");
  });

  it("goes to ai_active when the customer is owed a reply", () => {
    expect(stateOnRelease("inbound")).toBe("ai_active");
  });

  it("an empty conversation goes to ai_active", () => {
    expect(stateOnRelease(null)).toBe("ai_active");
  });
});

describe("how long it has been held", () => {
  const at = (iso: string) => new Date(iso);
  it("reads in the units a person would say", () => {
    expect(heldFor("2026-09-12T10:00:00Z", at("2026-09-12T10:00:30Z"))).toBe("just now");
    expect(heldFor("2026-09-12T10:00:00Z", at("2026-09-12T10:05:00Z"))).toBe("5 min");
    expect(heldFor("2026-09-12T10:00:00Z", at("2026-09-12T13:00:00Z"))).toBe("3h");
    expect(heldFor("2026-09-12T10:00:00Z", at("2026-09-14T10:00:00Z"))).toBe("2d");
  });

  it("a clock that disagrees does not produce a negative age", () => {
    // Server and browser clocks drift, and "held for -3 min" is nonsense on a
    // screen someone is trying to read.
    expect(heldFor("2026-09-12T10:05:00Z", at("2026-09-12T10:00:00Z"))).toBe("just now");
  });
});

/**
 * EMILY ANSWERING ON TOP OF A PERSON.
 *
 * The sequence, all of it real code paths: a customer texts and a turn is
 * queued; a person claims the conversation so the turn is DEFERRED an hour
 * rather than cancelled; the person answers the customer and releases;
 * stateOnRelease correctly returns 'awaiting_customer', which is not
 * 'ai_active', so nothing re-queues and nothing cancels; an hour later the
 * deferred turn runs and draftReply guarded only 'ended' and 'human_active'.
 */
describe("who still owes the customer a reply", () => {
  const at = (n: number) => new Date(Date.UTC(2026, 8, 21, 12, n)).toISOString();

  it("the bot owes one when the customer spoke last", () => {
    expect(latestInboundIsAnswered([
      { direction: "outbound", created_at: at(0) },
      { direction: "inbound", created_at: at(1) },
    ])).toBe(false);
  });

  it("the bot owes nothing once a person has replied", () => {
    // The whole bug in three rows.
    expect(latestInboundIsAnswered([
      { direction: "outbound", created_at: at(0) },
      { direction: "inbound", created_at: at(1) },
      { direction: "outbound", created_at: at(2) },
    ])).toBe(true);
  });

  it("owes one again when the customer comes back after that reply", () => {
    // 'awaiting_customer' must NOT be a reason to stay quiet forever, which is
    // why this reads the transcript rather than the state.
    expect(latestInboundIsAnswered([
      { direction: "inbound", created_at: at(1) },
      { direction: "outbound", created_at: at(2) },
      { direction: "inbound", created_at: at(3) },
    ])).toBe(false);
  });

  it("does not depend on the rows arriving in order", () => {
    // Postgres returns what it is asked for, but nothing in the type says the
    // array is sorted, and a reordering here would silently invert the answer.
    expect(latestInboundIsAnswered([
      { direction: "outbound", created_at: at(2) },
      { direction: "inbound", created_at: at(1) },
    ])).toBe(true);
  });

  it("owes nothing on an empty thread rather than guessing", () => {
    expect(latestInboundIsAnswered([])).toBe(true);
  });

  it("owes one when the only message is the customer's", () => {
    expect(latestInboundIsAnswered([{ direction: "inbound", created_at: at(0) }])).toBe(false);
  });

  it("lines up with what stateOnRelease decided", () => {
    // The two have to agree: if release says 'awaiting_customer' because the
    // last message was outbound, the pending turn must also see it answered.
    const msgs = [
      { direction: "inbound", created_at: at(1) },
      { direction: "outbound", created_at: at(2) },
    ];
    expect(stateOnRelease("outbound")).toBe("awaiting_customer");
    expect(latestInboundIsAnswered(msgs)).toBe(true);

    expect(stateOnRelease("inbound")).toBe("ai_active");
    expect(latestInboundIsAnswered([{ direction: "inbound", created_at: at(1) }])).toBe(false);
  });
});
