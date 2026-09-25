import { describe, it, expect } from "vitest";
import { validateAction, shouldEscalate, checkTone, type AgentAction } from "@/lib/messaging/agent-output";

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

  /**
   * A WRITTEN NUMBER IS STILL A PRICE.
   *
   * The pattern only looked for a written number in front of a MAGNITUDE —
   * "five hundred", "two grand" — so it caught those and let "fifty dollars"
   * straight through. Probed with twenty-one plausible prices, that was the
   * one shape that escaped, and it is not an exotic one: cabinet work is
   * quoted per door and lands on exactly this phrasing.
   */
  it("catches a price written out in words", () => {
    for (const t of [
      "fifty dollars", "fifty bucks", "twenty bucks", "a hundred bucks",
      "a couple hundred bucks", "about fifty bucks a door", "fifty quid",
      "about a grand", "a few grand", "fifty per door",
    ]) {
      const r = validateAction(ok({ freeText: t }));
      expect(r.ok, t).toBe(false);
      if (!r.ok) expect(r.reason, t).toBe("quoted_a_price");
    }
  });

  /**
   * The other half of the same trade. This filter is deliberately blunt, so
   * widening it costs ordinary sentences — the first version of the fix above
   * refused "a hundred percent" and "we cover a few hundred zip codes", which
   * is a worse failure than the hole it closed.
   */
  it("does not refuse ordinary sentences that happen to carry a number word", () => {
    for (const t of [
      "Absolutely, a hundred percent.",
      "We cover a few hundred zip codes.",
      "Got it, twenty doors is no problem.",
      "One of our estimators will come out.",
      "Give us a couple of days and we will be in touch.",
    ]) {
      expect(validateAction(ok({ freeText: t })).ok, t).toBe(true);
    }
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
      // THE TRADES LIST HAD THE SAME ORDER BUG THE SURFACES LIST FIXED.
      // It carried "window replacement", so this went out unrefused — along
      // with seven more of fourteen plausible out-of-scope promises.
      "we can replace the windows",
      "Yes, we can reroof that for you.",
      "we can fix the roof leak",
      "our electricians can rewire it",
      "we do concrete driveways",
      "we can pour a new foundation",
    ]) {
      const r = validateAction(ok({ freeText: t }));
      expect(r.ok, t).toBe(false);
      if (!r.ok) expect(r.reason).toBe("out_of_scope_work");
    }
  });

  /**
   * FLOORING IS NOT OUT OF SCOPE, and this test said it was until the Chatbot
   * screen showed it ticked. sms_services has a `flooring` row with
   * covered_by_default true, so the prompt tells the model PPP does it and a
   * regex here refused the model for agreeing. The hardcoded list must never
   * contradict the configured one — verify-workspace-config checks that
   * against the live table, which is the only place it can be checked
   * honestly.
   */
  it("does not refuse a service PPP actually offers", () => {
    for (const t of [
      "we install flooring",
      "Yes, we do drywall.",
      "We can handle the power washing.",
      "We do skim coating and lime washing.",
      "Cabinet refinishing is no problem.",
    ]) {
      expect(validateAction(ok({ freeText: t })).ok, t).toBe(true);
    }
  });

  /**
   * The nouns above cannot be matched bare. PPP paints window trim, door
   * frames and the boards under a roof line, so "window" and "roof" on their
   * own would refuse the work it actually sells. The verb is what makes it
   * somebody else's trade.
   */
  it("still allows painting work that touches those same nouns", () => {
    for (const t of [
      "We can paint the window trim.",
      "We'll paint the window frames and sills.",
      "We can paint the floor of the porch.",
      "We paint the boards under the roof line.",
      "We can prep and paint the siding.",
      "We'll paint the garage floor.",
    ]) {
      expect(validateAction(ok({ freeText: t })).ok, t).toBe(true);
    }
  });

  /**
   * THE FLOORING BUG WITH THE SIGN FLIPPED.
   *
   * "What we do not cover" on the Chatbot screen names seven categories. The
   * regex knew four, so furniture, industrial equipment and artistic painting
   * were promised freely. Same root cause as flooring — a configured list and
   * a hardcoded one that never met — just costing a promise PPP cannot keep
   * instead of a refusal it should not make.
   */
  it("refuses the rest of what the configuration excludes", () => {
    for (const t of [
      "Yes, we can paint your furniture.",
      "we can refinish the bookcase",
      "we do standalone shelving too",
      "we can coat your industrial equipment",
      "yes we paint industrial equipment",
      "we can do artistic painting",
      "graphic painting is no problem",
    ]) {
      const r = validateAction(ok({ freeText: t }));
      expect(r.ok, t).toBe(false);
      if (!r.ok) expect(r.reason, t).toBe("out_of_scope_work");
    }
  });

  /**
   * BUILT-IN IS NOT STANDALONE, and the configuration says so in those words:
   * "bookcases and shelving that are STANDALONE rather than built in". PPP
   * sells built-in work, so a bare noun here would refuse the job — the same
   * mistake the trades list made with "window" and "roof".
   */
  it("still allows built-in work, which the configuration does cover", () => {
    for (const t of [
      "We can paint the built-in shelving.",
      "We can paint your built in bookcases.",
      "We do built-in cabinetry.",
      "We can paint the trim and the built in shelves.",
    ]) {
      expect(validateAction(ok({ freeText: t })).ok, t).toBe(true);
    }
  });

  /**
   * THE BOT COULD NOT SAY NO.
   *
   * Every out-of-scope list matched a bare mention, so "we do not do roofing"
   * was refused as out_of_scope_work for containing the word roofing. The
   * rule against PROMISING work PPP does not do also blocked DECLINING it —
   * the one thing the configuration explicitly requires: "say we cannot help
   * with this project but will circle back if that is wrong."
   *
   * Found in the simulator asking about furniture and watching the model's
   * refusal get refused.
   */
  it("lets the bot turn work down in words", () => {
    for (const t of [
      "Unfortunately we do not paint furniture.",
      "We do not do murals, sorry.",
      "We cannot paint appliances.",
      "We do not do roofing.",
      "Sorry, we are not able to take on industrial equipment.",
      "That is not something we are able to help with, we do not refinish bathtubs.",
    ]) {
      expect(validateAction(ok({ freeText: t })).ok, t).toBe(true);
    }
  });

  /**
   * THE NEGATION CAN COME AFTER THE NOUN, AND THE APOSTROPHE IS CURLY.
   *
   * The first version read backwards from the banned word, so it caught "we
   * do not paint furniture" and still blocked "Furniture painting isn't
   * something we do" — the noun opens the sentence and there is nothing
   * behind it to read. Seen in the simulator, which reported the block on
   * "Furniture" with a capital F, which is what gave it away.
   *
   * And the contraction list named don't and can't but not isn't, which is
   * the word the model actually reached for.
   */
  it("lets the bot say no whichever way round the sentence is built", () => {
    for (const t of [
      "Furniture painting isn\u2019t something we do.",
      "Furniture painting isn't something we do.",
      "We aren\u2019t able to paint furniture.",
      "Murals aren't something we offer.",
      "I am afraid bathtubs are outside what we cover.",
    ]) {
      expect(validateAction(ok({ freeText: t })).ok, t).toBe(true);
    }
  });

  /** "not a problem" is how you say YES to a job, not how you refuse one. */
  it("does not read an agreement as a refusal", () => {
    for (const t of [
      "We can paint your furniture, not a problem",
      "Refinishing your bathtub is no problem.",
    ]) {
      expect(validateAction(ok({ freeText: t })).ok, t).toBe(false);
    }
  });

  /** The apostrophe is required, so an ordinary word ending in nt is safe. */
  it("does not treat the front door as a negation", () => {
    const r = validateAction(ok({ freeText: "We can paint the front door and your furniture." }));
    expect(r.ok).toBe(false);
    expect(validateAction(ok({ freeText: "We can paint the front door." })).ok).toBe(true);
  });

  /**
   * CLAUSE BY CLAUSE. A decline earlier in the sentence must not license a
   * promise later in it — "but" breaks the clause exactly as a full stop does.
   */
  it("still catches a promise that follows a decline in the same sentence", () => {
    const r = validateAction(ok({ freeText: "We do not do murals, but we can paint your appliances." }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("out_of_scope_work");
  });

  /**
   * THE THIRD GUARD TO BLOCK THE SAME REFUSAL.
   *
   * Out-of-scope blocked it for naming furniture. A9's echo check then
   * dropped it for repeating the customer's words — a refusal cannot avoid
   * that, since the customer asked about furniture and the only honest answer
   * says furniture. With the answer dropped, the turn was refused a third
   * time as question_left_unanswered.
   *
   * A9 is about reading SCOPE back as a confirmation, not about a word
   * appearing at all.
   */
  it("lets a refusal name the work it is refusing", () => {
    const customer = "Hi, do you guys paint furniture? I have a big standalone bookcase and a dresser I want redone in black";
    for (const t of [
      "Furniture painting isn't something we do.",
      "We do not paint furniture or standalone bookcases.",
      "Unfortunately a standalone bookcase is not work we cover.",
    ]) {
      expect(checkTone(t, customer).ok, t).toBe(true);
    }
  });

  it("still drops rapport that reads the customer's scope back at them", () => {
    const customer = "I need my living room and hallway painted, about 600 sq ft, walls and ceilings";
    const r = checkTone("Got it, your living room and hallway painted, about 600 sq ft.", customer);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toMatch(/repeats the customer/);
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

describe("A3 — asking is not collecting", () => {
  const asked = ["ask_project_details", "ask_address", "ask_contact", "ask_availability"];
  const ctx = (knownFields: Record<string, boolean>) => ({
    knownFields, stage: 4, priorIntents: asked, customerText: "ok",
  });

  /**
   * FOUND PLAYING A CUSTOMER WHO ANSWERS "ok" TO EVERYTHING.
   *
   * The A3 legs are satisfied by having ASKED, which is deliberate — it covers
   * A41's refusal carve-out without having to detect a refusal. But it meant
   * the bot could walk all four steps, collect nothing, and close as Success.
   *
   * Kate's definition of that outcome is "Details, address, contact and
   * availability collected. Checking the schedule." A Success on an empty
   * record tells the office a job is ready to book with nothing to book it
   * against.
   */
  it("refuses to close as booked holding nothing", () => {
    const r = validateAction(ok({ intent: "success", confidence: 0.97 }),
      ctx({ name: false, phone: false, email: false, address: false, inquiryScope: false }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("details_never_collected");
  });

  it("refuses when only the address is missing", () => {
    const r = validateAction(ok({ intent: "success", confidence: 0.97 }),
      ctx({ name: true, phone: true, email: true, address: false, inquiryScope: true }));
    expect(r.ok).toBe(false);
  });

  it("allows it once the record actually holds the job", () => {
    expect(validateAction(ok({ intent: "success", confidence: 0.97 }),
      ctx({ name: true, phone: true, email: true, address: true, inquiryScope: true })).ok).toBe(true);
    // Either contact channel is enough; A3 asks for contact, not for both.
    expect(validateAction(ok({ intent: "success", confidence: 0.97 }),
      ctx({ name: true, phone: true, email: false, address: true, inquiryScope: true })).ok).toBe(true);
  });

  /**
   * NOT phone_pricing. A3's carve-out is explicit: "where a street refusal has
   * been honoured, a zip alone is acceptable on a phone pricing."
   */
  it("leaves the phone pricing carve-out alone", () => {
    expect(validateAction(ok({ intent: "phone_pricing", confidence: 0.97 }),
      ctx({ name: false, phone: true, email: false, address: false, inquiryScope: true })).ok).toBe(true);
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
