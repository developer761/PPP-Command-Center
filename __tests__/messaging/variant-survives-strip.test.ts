import { describe, it, expect } from "vitest";
import { renderMessage } from "@/lib/messaging/render";

/**
 * QUESTION 23 — A SENTENCE THAT ONLY WORKS AS A PREAMBLE.
 *
 * defer_to_estimator rotates three wordings, and all three end on the
 * availability question so the turn cannot read as a sign-off. Before the
 * fourth leg that question is stripped as too early and the ask that is
 * actually due takes its place. Two of the three survive that intact. The
 * third does not:
 *
 *   "Our office confirms the timing, so they'll lock that in with you.
 *    What are you looking to have painted?"
 *
 * to somebody who asked how long it takes to paint a three-bedroom house.
 * "They'll lock that in" says a time is being booked, and none is — the
 * customer has not given us scope, an address or a contact yet.
 *
 * The answer was to not PICK it there. Kate's wording is right where she
 * wrote it, at stage 3 with its own question behind it, and that is the one
 * property these tests pin: the line is not retired, it is placed.
 */
const ask = (over: Record<string, unknown> = {}) => ({
  intent: "defer_to_estimator" as const,
  track: "new_lead" as const,
  customerText: "how long does it take to paint a 3 bedroom house?",
  known: {},
  turn: 2,
  flowStage: 0,
  ...over,
});

describe("a variant that does not survive the strip is not the one picked", () => {
  it.each([0, 1, 2])("stage %i does not promise to lock in a time", (flowStage) => {
    const out = renderMessage(ask({ flowStage }));
    expect(out).not.toMatch(/lock that in|confirms the timing/i);
    // Still an answer, and still a question — A33.
    expect(out).toMatch(/estimator/i);
    expect(out).toContain("?");
  });

  it.each([0, 1, 2])("the Spanish twin, stage %i", (flowStage) => {
    const out = renderMessage(ask({ flowStage, language: "es" }));
    expect(out).not.toMatch(/horarios|coordinar/i);
    expect(out).toMatch(/estimador/i);
    expect(out).toContain("?");
  });

  /**
   * THE OTHER HALF, AND THE ONE THAT MATTERS MORE.
   *
   * A guard that simply deleted the third wording would pass every assertion
   * above and quietly cost PPP a third of the variety Kate wrote. At stage 3
   * the days question stands, nothing is stripped, and turn 2 must still land
   * on her line.
   */
  it("keeps Kate's wording at the stage it was written for", () => {
    expect(renderMessage(ask({ flowStage: 3 }))).toContain(
      "Our office confirms the timing, so they'll lock that in with you.",
    );
    expect(renderMessage(ask({ flowStage: 3, language: "es" }))).toContain(
      "Nuestra oficina confirma los horarios",
    );
  });

  /**
   * And the rotation is still a rotation — the fix moves which turn reaches
   * which wording, it does not collapse three into one.
   */
  it("still rotates across turns at the stage that strips", () => {
    const seen = new Set(
      [0, 1, 2, 3, 4, 5].map((turn) => renderMessage(ask({ turn, flowStage: 1 }))),
    );
    expect(seen.size).toBeGreaterThan(1);
  });
});
