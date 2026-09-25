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
