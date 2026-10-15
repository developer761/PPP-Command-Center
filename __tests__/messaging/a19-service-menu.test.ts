import { describe, it, expect } from "vitest";
import { checkRapport, recitesTheMenu } from "@/lib/messaging/agent-output";

/**
 * A19 — "Do not recite the service menu back at the customer unless they
 * ask." A customer who wrote "I need my living room painted" asked for one
 * thing and could be handed a catalogue.
 */
const R = (t: string, customerText: string) => checkRapport(t, customerText, false, false);
const NOT_ASKED = "I need my living room painted";

describe("A19 — the menu is an answer, not an opener", () => {
  it.each([
    "We do interior painting, exterior painting, lime washing and skim coating.",
    "We handle interior painting, exterior painting, cabinets, wallpaper and drywall.",
    "We offer interior and exterior painting, power washing and skim coating.",
  ])("refuses %j when they did not ask", (t) => {
    expect(R(t, NOT_ASKED).ok).toBe(false);
  });

  /** When they DID ask, the list is the answer and must go out. */
  it.each([
    ["We do interior painting, exterior painting, lime washing and skim coating.", "what kinds of work do you do?"],
    ["We do interior painting, exterior painting and drywall.", "do you guys do drywall?"],
    ["We offer interior painting, exterior painting and cabinets.", "what services do you offer?"],
  ])("allows %j when the customer asked", (t, asked) => {
    expect(R(t, asked).ok).toBe(true);
  });

  /**
   * THREE is the threshold, not two. "We do interior and exterior painting"
   * is how a person answers a question about scope; Kate's rule is about the
   * LIST, the point where it reads as a menu rather than a sentence.
   */
  it.each([
    "Yes, we do interior painting.",
    "We do interior and exterior painting.",
  ])("leaves one or two services alone: %j", (t) => {
    expect(R(t, NOT_ASKED).ok).toBe(true);
  });

  /**
   * The capability verb is required, so the CUSTOMER's own list coming back
   * in a scope summary is untouched — three items, no claim about what we
   * offer.
   */
  it("never fires on the customer's own list", () => {
    expect(recitesTheMenu("Got it: the kitchen, two bedrooms and the hall.")).toBe(false);
    expect(R("Got it: the kitchen, two bedrooms and the hall.", NOT_ASKED).ok).toBe(true);
  });

  /**
   * Scored against the corpus WITHOUT customer text — the worst case, since
   * it assumes nobody ever asked. 4 of 2,155 faulted flagged, and the single
   * praised message it touches opens "Yes, we do." — proof that a question
   * preceded it, which the carve-out handles in production where the text is
   * available.
   */
  it("would allow the one praised message the worst case flags", () => {
    const praised = "Yes, we do. We provide interior and exterior painting, skim coating, flooring, drywall and power washing.";
    expect(recitesTheMenu(praised)).toBe(true);
    expect(recitesTheMenu(praised, "do you do flooring?")).toBe(false);
  });
});
