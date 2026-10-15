import { describe, it, expect } from "vitest";
import { validateAction } from "@/lib/messaging/agent-output";

/**
 * A1 — "Never provide a quoted price."
 *
 * Found by re-probing the findings a verifier had REFUTED as already
 * enforced. It mostly is: of seven plausible prices, six were refused. The
 * two gaps below were not, and they run in opposite directions.
 */
const ctx = {
  knownFields: {}, addressGap: null, templateAsks: () => false,
  customerMessages: [], flowStage: 2,
} as never;
const V = (t: string) => validateAction({ intent: "answer_question", confidence: 0.97, freeText: t }, ctx);

describe("A1 — a price with no digits in it", () => {
  /**
   * A1's corrective forbids "no price, no ballpark AND NO RANGE". These
   * carry no digit and no currency word, and a customer reads every one as
   * a price.
   */
  it.each([
    "Expect somewhere in the low thousands.",
    "It's usually in the hundreds.",
    "Somewhere in the mid thousands.",
    "Under a thousand usually.",
    "In the low to mid thousands.",
  ])("refuses %j", (t) => {
    const v = V(t);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("quoted_a_price");
  });

  /** A magnitude followed by a UNIT is a measurement, not a price. */
  it.each([
    "There are a few thousand square feet to cover.",
    "About two thousand sq ft of wall.",
    "It's a couple hundred square feet.",
    "We'll need a few gallons for that.",
  ])("allows the measurement %j", (t) => {
    expect(V(t).ok).toBe(true);
  });
});

describe("A1 — a money word near a number that is not money", () => {
  /**
   * THE OTHER DIRECTION, and it was blocking messages Kate PRAISED. The rule
   * matched any digit within 24 characters of a money word, and in a
   * painting conversation most digits are counts or house numbers:
   *
   *   "your text quote moving, is 8 Marlo…"      a house number
   *   "a rough estimate for a living area and 2 bedrooms"   a count
   *
   * So the bot could not say "estimate for 2 bedrooms" without the turn
   * being refused for a price it never quoted. Corpus false positives on
   * praised messages went 3 to 0.
   */
  it.each([
    "Before we get your text quote moving, is 8 Marlo, Livingston the address?",
    "Since you're looking for a rough estimate for a living area and 2 bedrooms, what's the address?",
    "The quote covers 3 rooms.",
    "The estimate includes 2 coats.",
    "Price it for 1200 square feet.",
    "Your quote will be ready soon.",
  ])("allows %j", (t) => {
    expect(V(t).ok).toBe(true);
  });

  /** Every money-shaped form is still caught. */
  it.each([
    "The price is 2500.",
    "Cost runs about 1800.",
    "Your quote is $3,200.",
    "The rate is 3 dollars per square foot.",
    "Estimates start at 900.",
    "Price: 2500",
  ])("still refuses %j", (t) => {
    expect(V(t).ok).toBe(false);
  });
});
