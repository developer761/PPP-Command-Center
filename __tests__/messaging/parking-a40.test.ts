/**
 * A40 — park the open item, and know which kind of park it is.
 *
 * Kate's two situations have OPPOSITE failures, which is what makes this
 * worth enforcing in code rather than asking for in a prompt:
 *
 *   field park        failure = closing having gathered nothing
 *   conversation park failure = carrying on collecting, and pressing
 *
 * A detector that cannot tell them apart nags the person who deferred and
 * abandons the person who just did not know one answer.
 */
import { describe, it, expect } from "vitest";
import { parkKind, conversationWasDeferred, isAsk } from "@/lib/messaging/parking";
import { validateAction } from "@/lib/messaging/agent-output";

const act = (intent: string, over: Record<string, unknown> = {}) =>
  ({ intent, confidence: 0.9, ...over });

describe("A40 — which kind of park", () => {
  it("reads a deferred CONVERSATION", () => {
    for (const t of [
      "I'll get back to you next week",
      "Let me come back to you on that",
      "I'll reach out when I'm ready",
      "call me tomorrow and we can sort it",
      "I'll book it by phone",
      "I'll be in touch once things settle down",
    ]) {
      expect(parkKind(t), t).toBe("conversation");
    }
  });

  it("reads a parked FIELD", () => {
    for (const t of [
      "I need my kitchen painted, and maybe more but I'm not sure right now",
      "I'm available in March but need to talk with my wife",
      "not sure yet on the dates",
      "I need to check with my landlord first",
      "I don't know my availability offhand",
      "waiting on my tenant to confirm",
    ]) {
      expect(parkKind(t), t).toBe("field");
    }
  });

  /**
   * 🔴 THE A17 BOUNDARY. Kate: "parking is not stopping… Wrong one and you
   * either nag someone who said no, or abandon someone who said later."
   *
   * And 2026-09-18: "A DECLINE IS NOT ALWAYS WORDED AS ONE. 'We actually
   * found someone' is a decline; so is 'we went another way'… a keyword sweep
   * for this missed exactly that one."
   */
  it("never reads a DECLINE as a park", () => {
    for (const t of [
      "We actually found someone",
      "we went another way",
      "no thanks, not interested",
      "we already hired somebody",
      "I've changed my mind",
      "we're all set",
    ]) {
      expect(parkKind(t), t).toBeNull();
    }
  });

  /**
   * 🔴 THE A7 BOUNDARY. Kate: "THIS IS A CARVE-OUT ON THE DEFERRAL, NOT ON
   * THE QUOTE-DELIVERY CHANNEL. A customer taking the QUOTE by phone or text
   * is a Phone Pricing and still owes project details, full address and
   * contact (A3)."
   */
  it("never reads a quote-delivery request as a park", () => {
    for (const t of [
      "can you just text me the quote",
      "email me the estimate instead",
      "I'd rather get the price by phone",
    ]) {
      expect(parkKind(t), t).toBeNull();
    }
  });

  it("says nothing about an ordinary message", () => {
    for (const t of ["I need my whole house painted", "Sounds good", "", null]) {
      expect(parkKind(t)).toBeNull();
    }
  });

  it("prefers CONVERSATION when a message is both", () => {
    // "I'll get back to you once I check with my wife" defers the
    // conversation AND names a field. Treating it as a field would keep
    // collecting against a conversation they already moved — failure (2).
    expect(parkKind("I'll get back to you once I check with my wife")).toBe("conversation");
  });
});

describe("A40 — a deferral does not expire", () => {
  it("is still true a turn later", () => {
    expect(conversationWasDeferred(["I need the hallway done", "I'll get back to you"])).toBe(true);
    // The pressing happens on the NEXT turn, so the latest message alone
    // cannot answer this.
    expect(conversationWasDeferred(["I'll get back to you", "ok"])).toBe(true);
  });

  it("is not invented from an ordinary thread", () => {
    expect(conversationWasDeferred(["I need the hallway done", "4821 Oak Lane"])).toBe(false);
    expect(conversationWasDeferred([])).toBe(false);
  });
});

describe("A40 (2) — the bot may not press after they moved the conversation", () => {
  const deferred = { customerMessages: ["I'll get back to you next week"], customerText: "ok" };

  for (const intent of [
    "ask_project_details", "ask_address", "ask_contact", "ask_availability",
    "confirm_address", "confirm_contact",
  ]) {
    it(`refuses ${intent}`, () => {
      const r = validateAction(act(intent), deferred);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("pressed_after_deferral");
    });
  }

  it("still allows an intent that is not an ask", () => {
    // Acknowledging and parking is the CORRECT move here, so it must pass.
    const r = validateAction(act("schedule_follow_up"), deferred);
    expect(r.ok).toBe(true);
  });

  it("leaves an ordinary conversation alone", () => {
    const r = validateAction(act("ask_address"), {
      customerMessages: ["I need the hallway done"], customerText: "sure",
    });
    expect(r.ok).toBe(true);
  });

  it("does not fire on a DECLINE, which is A17's to handle", () => {
    const r = validateAction(act("ask_address"), {
      customerMessages: ["we went another way"], customerText: "",
    });
    expect(r.ok).toBe(true);
  });
});

describe("A40 (1) — a parked field is not a reason to quit", () => {
  it("refuses an ending that gathered nothing", () => {
    const r = validateAction(act("schedule_follow_up"), {
      customerText: "I'm available in March but need to talk with my wife",
      priorIntents: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("parked_a_field_then_quit");
  });

  it("allows it once the rest was collected, which is what Kate asks for", () => {
    // Hatch does exactly this: confirm details, address and contact, skip
    // availability, then End: Schedule Follow Up.
    const r = validateAction(act("schedule_follow_up"), {
      customerText: "not sure on dates, I need to check with my wife",
      priorIntents: ["ask_project_details", "ask_address", "ask_contact"],
    });
    expect(r.ok).toBe(true);
  });

  it("does not fire when the CONVERSATION was parked rather than a field", () => {
    // Stopping is correct there — that is situation (2).
    const r = validateAction(act("schedule_follow_up"), {
      customerText: "I'll get back to you next week",
      priorIntents: [],
    });
    expect(r.ok).toBe(true);
  });

  it("does not fire on a decline", () => {
    const r = validateAction(act("schedule_follow_up"), {
      customerText: "we found someone else", priorIntents: [],
    });
    expect(r.ok).toBe(true);
  });
});

describe("isAsk covers every collecting intent", () => {
  it("includes the confirms, which also put a question to the customer", () => {
    for (const i of ["ask_address", "ask_contact", "confirm_scope", "confirm_contact"]) {
      expect(isAsk(i), i).toBe(true);
    }
    for (const i of ["schedule_follow_up", "acknowledge", "success", "bailout"]) {
      expect(isAsk(i), i).toBe(false);
    }
  });
});
