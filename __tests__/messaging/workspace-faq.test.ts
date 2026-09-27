/**
 * Hatch parity gap 9 — the standing answers a workspace holds.
 *
 * These are BOT-FACING: the whole point is that the bot answers from them.
 * That makes the knowledge base a second place a sentence can reach a
 * customer from, so the content is subject to the same rules as anything else
 * the bot says — and two of them can be broken by the CONTENT rather than by
 * the reply.
 */
import { describe, it, expect } from "vitest";
import { checkFaq, usableFaqs, faqsForPrompt } from "@/lib/messaging/workspace-faq";

const ok = (question: string, answer: string) => ({ question, answer });

describe("an answer that is safe to say", () => {
  it("passes a real one from Hatch", () => {
    expect(checkFaq(ok("Are you insured?", "Yes, we are fully licensed and insured."))).toEqual([]);
    expect(checkFaq(ok("Where are you located?", "We serve the majority of the greater Los Angeles and Orange County area."))).toEqual([]);
  });
});

describe("A1 — an answer may never carry a price", () => {
  /**
   * The failure this prevents is subtle: an FAQ with a number in it LAUNDERS
   * a quote. The validator sees a model that answered a question, not one
   * that invented a price, because the price was handed to it.
   */
  for (const a of [
    "It usually runs $2,500 for a room that size.",
    "Most interiors are 800 to 1200 dollars.",
    "We charge per square foot, about $4",
    "Expect around 3000 USD.",
  ]) {
    it(`refuses ${JSON.stringify(a.slice(0, 34))}…`, () => {
      const problems = checkFaq(ok("how much will this cost", a));
      expect(problems.some((p) => p.why.includes("price"))).toBe(true);
    });
  }

  it("allows an answer that declines to give one", () => {
    expect(checkFaq(ok(
      "how much will this cost",
      "Pricing is something our estimator goes over with you directly after seeing the space."
    ))).toEqual([]);
  });

  it("does not trip on an ordinary number", () => {
    // A warranty length and a phone number are not prices.
    expect(checkFaq(ok("Do you warranty the work?", "Yes, we stand behind our work with a 2 year warranty."))).toEqual([]);
    expect(checkFaq(ok("What is your number?", "You can reach us on 877-645-3563."))).toEqual([]);
  });
});

describe("A18 — an answer may never name somebody else", () => {
  for (const a of [
    "We don't do that, but you could try another company.",
    "That isn't us, try calling a different contractor.",
    "We'd recommend another painter for flooring.",
  ]) {
    it(`refuses ${JSON.stringify(a.slice(0, 34))}…`, () => {
      const problems = checkFaq(ok("do you do flooring", a));
      expect(problems.some((p) => p.why.includes("another company"))).toBe(true);
    });
  }

  it("allows saying what we do not cover and stopping there", () => {
    expect(checkFaq(ok("do you do roofing", "That isn't something we take on. We cover interior and exterior painting, cabinets and drywall."))).toEqual([]);
  });
});

describe("an answer is a text message, not a document", () => {
  it("refuses something enormous", () => {
    const problems = checkFaq(ok("tell me everything", "x".repeat(700)));
    expect(problems.some((p) => p.why.includes("text message"))).toBe(true);
  });

  it("refuses a blank one", () => {
    expect(checkFaq(ok("q", "   ")).some((p) => p.field === "answer")).toBe(true);
    expect(checkFaq(ok("  ", "a")).some((p) => p.field === "question")).toBe(true);
  });

  it("reports every problem at once, not just the first", () => {
    const problems = checkFaq(ok("cost", "It's about $3,000, or try another company."));
    expect(problems.length).toBeGreaterThanOrEqual(2);
  });
});

describe("a bad row never reaches the prompt", () => {
  it("is dropped, and reported", () => {
    const { usable, rejected } = usableFaqs([
      ok("Are you insured?", "Yes, fully licensed and insured."),
      ok("how much", "About $2,500."),
    ]);
    expect(usable).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].problems[0].why).toMatch(/price/);
  });

  it("and the prompt carries only what survived", () => {
    const out = faqsForPrompt([
      ok("Are you insured?", "Yes, fully licensed and insured."),
      ok("how much", "About $2,500."),
    ]);
    expect(out).toContain("Are you insured?");
    expect(out).not.toContain("$2,500");
  });
});

describe("the prompt section", () => {
  it("is empty when the workspace has none", () => {
    // A workspace with no knowledge base behaves exactly as it does today,
    // rather than getting a heading over nothing.
    expect(faqsForPrompt([])).toBe("");
  });

  /**
   * The framing matters as much as the content. Without this a model treats
   * a knowledge base as a script and starts volunteering answers nobody
   * asked for — a second ask in disguise (A22) that pulls the conversation
   * off the required flow.
   */
  it("says only when asked, and not to volunteer", () => {
    const out = faqsForPrompt([ok("Are you insured?", "Yes.")]);
    expect(out).toMatch(/ONLY WHEN ASKED/);
    expect(out).toMatch(/Do not volunteer/);
    expect(out).toMatch(/second ask in disguise/);
  });

  it("tells it to say it will find out rather than guess", () => {
    expect(faqsForPrompt([ok("q", "a")])).toMatch(/find out rather than guessing/);
  });

  it("renders each pair once, in order", () => {
    const out = faqsForPrompt([ok("First?", "One."), ok("Second?", "Two.")]);
    expect(out.indexOf("First?")).toBeLessThan(out.indexOf("Second?"));
    expect(out.match(/Q: /g)).toHaveLength(2);
  });
});
