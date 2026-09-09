import { describe, it, expect } from "vitest";
import { validateAction, shouldEscalate, type AgentAction } from "@/lib/messaging/agent-output";

const ok = (over: Partial<AgentAction> = {}) => ({ intent: "acknowledge", confidence: 0.98, ...over });

describe("validateAction — the shape itself", () => {
  it("accepts a well-formed action", () => {
    expect(validateAction(ok()).ok).toBe(true);
  });

  it("rejects an intent outside the allowed set", () => {
    // The model cannot invent a new thing to do.
    const r = validateAction(ok({ intent: "book_the_job" as never }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unknown_intent");
  });

  it("accepts every one of Emily's end states", () => {
    for (const intent of ["success","discard","schedule_follow_up","lost","bailout","phone_pricing","transferred","bot_suspected","msg_liked_loved","area_not_serviced"] as const) {
      expect(validateAction(ok({ intent })).ok, intent).toBe(true);
    }
  });

  it("rejects rubbish rather than throwing", () => {
    for (const bad of [null, undefined, "hello", 42, []]) {
      const r = validateAction(bad);
      expect(r.ok, String(bad)).toBe(false);
    }
  });

  it("rejects a confidence outside 0 to 1", () => {
    for (const c of [-0.1, 1.5, NaN, "high" as never, undefined as never]) {
      const r = validateAction(ok({ confidence: c }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("confidence_out_of_range");
    }
  });
});

describe("validateAction — never quote a price", () => {
  it("catches a price in free text", () => {
    // Emily's prompt: "Never provide a quoted price; that is the estimator's job."
    for (const t of [
      "It'll be around $400",
      "the price is about 400 dollars",
      "your estimate would be roughly 2000",
      "that costs around 800",
    ]) {
      const r = validateAction(ok({ freeText: t }));
      expect(r.ok, t).toBe(false);
      if (!r.ok) expect(r.reason).toBe("quoted_a_price");
    }
  });

  it("allows talking about a quote without quoting one", () => {
    const r = validateAction(ok({ freeText: "We can text or email you a quote. Which would you prefer?" }));
    expect(r.ok).toBe(true);
  });
});

describe("validateAction — never offer a time we do not have", () => {
  it("rejects an invented time", () => {
    // "Never offer, confirm, or suggest appointment times yourself." A time
    // with nothing behind it is how a customer waits for an estimator who was
    // never booked.
    for (const t of ["How about 2pm?", "Does Tuesday work?", "We can come tomorrow", "Someone is free next week"]) {
      const r = validateAction(ok({ freeText: t }));
      expect(r.ok, t).toBe(false);
      if (!r.ok) expect(r.reason).toBe("invented_availability");
    }
  });

  it("ALLOWS a time the system actually supplied", () => {
    const r = validateAction(
      ok({ freeText: "Does 2pm work?" }),
      { verifiedSlots: { times: ["2026-09-10T14:00:00Z"] } }
    );
    expect(r.ok).toBe(true);
  });

  it("rejects proposed times when the verified list is empty", () => {
    const r = validateAction(
      ok({ intent: "ask_availability", slots: { times: ["2pm"] } }),
      { verifiedSlots: { times: [] } }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invented_availability");
  });
});

describe("validateAction — never promise work PPP does not do", () => {
  it("catches out-of-scope trades", () => {
    for (const t of [
      "We can handle the roofing too",
      "our team does plumbing as well",
      "we also do landscaping",
      "we can refinish the bathtub",
      // Order-independent. The first version required "bathtub refinishing"
      // in that order and let this straight through.
      "bathtub refinishing is no problem",
      "we can paint your appliances",
      "we do murals too",
    ]) {
      const r = validateAction(ok({ freeText: t }));
      expect(r.ok, t).toBe(false);
      if (!r.ok) expect(r.reason).toBe("out_of_scope_work");
    }
  });

  it("allows the work PPP actually does", () => {
    for (const t of [
      "We do interior and exterior painting.",
      "Cabinets and trim are included.",
      "Minor repairs are included.",
    ]) {
      expect(validateAction(ok({ freeText: t })).ok, t).toBe(true);
    }
  });
});

describe("validateAction — Kate's hard nos", () => {
  it("blocks a phrase she banned", () => {
    const r = validateAction(
      ok({ freeText: "We offer a lifetime warranty on all work" }),
      { hardNoPhrases: ["lifetime warranty"] }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("banned_by_hard_no");
  });

  it("matches whole words, so a ban does not gut ordinary text", () => {
    // Banning "deck" must not trip on "decking decision" — actually it should
    // match "deck" as a word but not inside another word.
    const r = validateAction(ok({ freeText: "The bedecked porch" }), { hardNoPhrases: ["deck"] });
    expect(r.ok).toBe(true);
  });

  it("ignores an empty or whitespace ban rather than blocking everything", () => {
    // A blank row in Kate's list would otherwise match every message.
    const r = validateAction(ok({ freeText: "Okay!" }), { hardNoPhrases: ["", "   "] });
    expect(r.ok).toBe(true);
  });

  it("survives a ban phrase containing regex characters", () => {
    expect(() => validateAction(ok({ freeText: "hi" }), { hardNoPhrases: ["50% off (limited)"] })).not.toThrow();
  });
});

describe("shouldEscalate", () => {
  it("escalates a consequential intent below the threshold", () => {
    // answer_question commits PPP to a statement about scope, so it stays on
    // the strict setting.
    expect(shouldEscalate({ intent: "answer_question", confidence: 0.8 }, { confidenceThreshold: 0.95 })).toBe(true);
    expect(shouldEscalate({ intent: "answer_question", confidence: 0.97 }, { confidenceThreshold: 0.95 })).toBe(false);
  });

  /**
   * The bug this tiering exists for. A flat 0.95 escalated a textbook opening
   * question — the model reports about 0.90 on one — so the FIRST turn of
   * every conversation handed to a human. That is not a cautious bot, it is a
   * broken one, and it would have buried the office on day one.
   */
  it("does not escalate a routine question the model is merely 90% sure of", () => {
    expect(shouldEscalate({ intent: "ask_project_details", confidence: 0.9 }, { confidenceThreshold: 0.95 })).toBe(false);
  });

  it("still escalates a routine question when the model is genuinely lost", () => {
    expect(shouldEscalate({ intent: "ask_project_details", confidence: 0.3 }, { confidenceThreshold: 0.95 })).toBe(true);
  });

  it("keeps every ending on the strict threshold", () => {
    for (const intent of ["success", "lost", "phone_pricing", "area_not_serviced", "offer_offsite_quote"] as const) {
      expect(shouldEscalate({ intent, confidence: 0.9 }, { confidenceThreshold: 0.95 }), intent).toBe(true);
    }
  });

  it("never loosens a threshold that is already looser than the floor", () => {
    // A workspace that has earned 0.3 does not get raised back to 0.5.
    expect(shouldEscalate({ intent: "ask_address", confidence: 0.35 }, { confidenceThreshold: 0.3 })).toBe(false);
  });

  it("always escalates an explicit escalate intent, however confident", () => {
    expect(shouldEscalate({ intent: "escalate", confidence: 1 })).toBe(true);
  });

  it("defaults to the strict 0.95 for a consequential intent when none is given", () => {
    // Starts strict and comes down as it earns it, not the other way round.
    expect(shouldEscalate({ intent: "answer_question", confidence: 0.94 })).toBe(true);
  });
});
