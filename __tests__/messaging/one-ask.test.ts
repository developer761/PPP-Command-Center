import { describe, it, expect } from "vitest";
import { tooManyAsks } from "@/lib/messaging/one-ask";
import { SAYS } from "@/lib/messaging/render";
import { checkRapport } from "@/lib/messaging/agent-output";

/**
 * A22, 63 breaches: "One ASK per message — COUNT ASKS, NOT QUESTION MARKS."
 *
 * Kate deleted the question-mark check from her own tooling: "the '?' count
 * was removed 2026-09-10 because it proves nothing either way." Our template
 * test was counting exactly that, so a template packing three fields into one
 * sentence with a single '?' would have passed it.
 */

describe("counting asks rather than punctuation", () => {
  it("one question mark, three asks", () => {
    // The case the '?' count cannot see.
    const p = tooManyAsks("What's your name, email and phone number?");
    expect(p).not.toBeNull();
    expect(p).toContain("produce 3 things");
  });

  it("one question mark, one ask, because we hold the values", () => {
    // Kate's own example of a CORRECT message.
    expect(tooManyAsks("Is {phone} and {email} still the best contact?")).toBeNull();
  });

  it("two produced fields is acceptable", () => {
    expect(tooManyAsks("And what's the best name and email for the estimate?")).toBeNull();
  });

  it("an address is ONE field however many parts are named", () => {
    // "the house number and street name, plus the zip code is one ask, not
    // three."
    expect(tooManyAsks("What's the house number and street name, plus the zip code?")).toBeNull();
  });
});

describe("two yes or no questions is ambiguous, even as read-backs", () => {
  it("refuses two separate yes/no questions", () => {
    const p = tooManyAsks("Is {address} still right? Are {phone} and {email} the best contact?");
    expect(p).not.toBeNull();
    expect(p).toContain("which one it answered");
  });

  it("allows one yes/no question holding both values", () => {
    // "Confirm one thing per message, or put both values inside a SINGLE
    // question."
    expect(tooManyAsks("Is {phone} and {email} the best contact for your appointment and quote details?")).toBeNull();
  });
});

/**
 * THE TEMPLATES, HELD TO THE RULE AS WRITTEN.
 *
 * Our templates are a finite set we wrote, so the mechanical half of A22 can
 * be enforced on them even though grading a live conversation against it is,
 * in Kate's words, "a judgement call".
 */
describe("every template asks for one thing", () => {
  const all = Object.entries(SAYS).flatMap(([intent, variants]) =>
    variants.map((text, i) => ({ intent, i, text }))
  );

  it("has templates to check", () => {
    expect(all.length).toBeGreaterThan(30);
  });

  it.each(all.filter((t) => t.text.trim()))("$intent [$i]", ({ text }) => {
    expect({ text, problem: tooManyAsks(text) }).toEqual({ text, problem: null });
  });
});

/**
 * The model's half is held somewhere else, and it is worth stating why this
 * file does not need to cover it: rapport may contain no question at all, so
 * it cannot add a second ask to a template that already has one.
 */
describe("the model cannot add a second ask", () => {
  it("rapport carrying a question is dropped", () => {
    expect(checkRapport("Got it. What day works?").ok).toBe(false);
  });

  it("rapport without one is kept", () => {
    expect(checkRapport("Got it, thank you.").ok).toBe(true);
  });
});

describe("what it leaves alone", () => {
  it.each([
    "What are you looking to have painted?",
    "What's the address for the project?",
    "What days generally work best for you?",
    "Thanks! What's the zip code for {address}?",
    "We can provide a quick quote for this project. Do you prefer text or email?",
    "",
  ])("allows %j", (t) => {
    expect(tooManyAsks(t)).toBeNull();
  });

  it("allows a consent question plus the action it enables", () => {
    // "ALSO ONE ASK: a CONSENT question plus the action it enables... is a
    // single move."
    expect(tooManyAsks("Are you open to an in-person appointment? Just let me know when you're available.")).toBeNull();
  });
});

/**
 * VOLUME COUNTS WHAT THE CUSTOMER MUST PRODUCE, SO A STATEMENT CANNOT COUNT.
 *
 * This scanned the whole message, so a sentence about what WE will do counted
 * against the limit:
 *
 *   "I'll check the calendar for that time. What's the address for the
 *    project?"
 *
 * came back "3 things at once (address, availability, scope)" — one question,
 * with "calendar/time" read as an availability ask and "project" as a scope
 * ask, both out of the declarative half. Found on 2026-09-27 when the false
 * positive suppressed an acknowledgement A15 had just added, and only on
 * even-numbered turns, because the odd-turn template variant is worded
 * differently.
 */
describe("a sentence that does not ask cannot be an ask", () => {
  it("allows a statement about our next step in front of one question", () => {
    expect(tooManyAsks("I'll check the calendar for that time. What's the address for the project?")).toBeNull();
  });

  it("still counts a requesting sentence with no question mark", () => {
    // "Let me know" and "I'll need" are asks whatever the punctuation.
    expect(tooManyAsks("Let me know your name, your email and your phone number.")).toMatch(/3 things/);
    expect(tooManyAsks("I'll need your name, email and phone.")).toMatch(/3 things/);
  });

  it("still catches a genuine three-field question", () => {
    expect(tooManyAsks("What's your name, and your email, and the best phone number to reach you?"))
      .toMatch(/3 things/);
  });

  it("still catches two yes/no questions", () => {
    expect(tooManyAsks("Is 12 Oak St right? Are you free Tuesday?")).toMatch(/2 separate yes or no/);
  });

  it("two produced fields in one question is still fine", () => {
    expect(tooManyAsks("And what's the best name and email for the estimate?")).toBeNull();
  });
});

/**
 * A CONFIRMATION PLUS AN OPEN ASK IS TWO ASKS.
 *
 * These are not invented: every "breach" case below is a bot message from
 * Kate's own corpus that she graded as an A22 breach and that the earlier
 * checks missed. Of her 61 A22 breaches carrying the faulted text, they caught
 * 49; ten of the twelve misses are this one shape — a scope or zip
 * confirmation followed by an ask for a new field.
 *
 * Neither earlier check can see it. There is only ONE yes/no question, and the
 * produced-field count is skipped whenever the message reads a held value
 * back, which a message of this shape nearly always does.
 *
 * The "allowed" cases are messages Kate PRAISED. The rule newly flags zero of
 * all 651 she praised, which is the half worth protecting: a one-ask opener
 * must stay legal.
 */
describe("a confirmation and a new ask are two asks (from Kate's corpus)", () => {
  it.each([
    "Got it! I have a bedroom and hallway(s) for painting, is that correct? What's the full address for the property, including the zip?",
    "Got it! I have interior painting for a new home, is that correct? Also, what's the full address for the new home, including the zip?",
    "Got it. I have a 2-bedroom apartment with a couple minor wall patches, is that right? What's the full address for the quote, including the zip?",
  ])("flags: %j", (text) => {
    expect(tooManyAsks(text), "this is two asks and went out as one").toBeTruthy();
  });

  /**
   * WHAT IS STILL MISSED, named rather than left to be rediscovered.
   *
   * 52 of Kate's 61 A22 breaches are caught. The remaining nine are two other
   * shapes, both left alone deliberately: widening the rule to reach them is
   * what produced the 25 false positives described below, and a rail that
   * drops good messages costs more than one that misses some bad ones.
   *
   *   ONE SENTENCE, BOTH ASKS
   *     "Okay! Is {zip} the correct zip code for the house, and what's the
   *      full street address?"
   *     The confirmation and the open ask share a sentence, so the
   *     separate-sentence requirement cannot see it.
   *
   *   TWO BARE CONFIRMATIONS
   *     "Got it! Painting the living room, dining room, and hallway ceilings,
   *      correct? Is {address} the correct address?"
   *     Two closed questions, but "correct?" alone carries no yes/no verb, so
   *     YES_NO counts one instead of two.
   *
   * Worth raising with Kate before chasing either: she grades A22 as "a
   * judgement call, so expect looser blind-rater agreement than a mechanical
   * rule", and this is where that judgement sits.
   */

  /**
   * AND THE ONE-ASK MESSAGES STAY LEGAL. The first version of this rule tested
   * "some sentence confirms" and "some sentence asks openly" independently, so
   * ONE sentence could satisfy both — "What are you looking to have painted?"
   * carries "are" and a question mark. It flagged 25 of Kate's praised
   * messages before the two were required to be separate sentences.
   */
  it.each([
    "Hi! What kind of project are you looking to get a quote for?",
    "Got it. What painting project are we quoting for?",
    "Yes, we do. Our estimates are free. What are you looking to have painted or worked on?",
    "Hey! Just circling back so we can get your free estimate lined up. What day and time window next week is easiest for you?",
    "Got it. What's the address for the project?",
    "Is {address} the correct address?",
    "What days work best for you this week?",
  ])("allows: %j", (text) => {
    expect(tooManyAsks(text), "a single ask was flagged as two").toBeNull();
  });
});
