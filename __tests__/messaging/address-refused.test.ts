import { describe, it, expect } from "vitest";
import { renderMessage } from "@/lib/messaging/render";
import { validateAction } from "@/lib/messaging/agent-output";

/**
 * A REFUSED ADDRESS — the half of A41 that the partial-address work missed.
 *
 * ── WHAT WAS PLAYED, 2026-10-05, against the live build ─────────────────
 *
 *   customer  "i need my kitchen and living room painted"
 *   bot       "What's the address for the project?"            ask_address
 *   customer  "id rather not give my address out over text"
 *   bot       "Totally understandable. What address should we
 *              have the estimator go to?"                      ask_address
 *   customer  "no im not giving that out, i told you"
 *   bot       phone_pricing — REFUSED, details_never_collected
 *
 * Two separate defects in one run, and they pull in opposite directions:
 *
 *   THE WORDING. A refusal is not a PARTIAL address, so none of A11's gap
 *   narrowing applied and ask_address fell through to its ordinary variants —
 *   the same question a second time with no reason attached. Kate, 2026-10-05:
 *   "Letting them know we at least need to confirm the zip code to provide an
 *   accurate estimate is valid." The zip floor existed; only the half-address
 *   branch could reach it.
 *
 *   THE DESTINATION. The prompt had just been changed to send a refusal to
 *   "phone_pricing", and that intent is in CLAIMS_THE_FLOW_FINISHED on Kate's
 *   own instruction: "A Phone Pricing is NOT [a deferral]: the quote going out
 *   by text or phone still requires all three here." So a phone quote is the
 *   END of the flow, not an escape from it, and reaching for it before asking
 *   for contact details is refused — which hands the best remaining outcome to
 *   a person instead.
 *
 * The validator was right both times. What was missing was a legal move
 * between the two rules, which is this repo's most expensive bug shape.
 */

const base = {
  intent: "ask_address" as const,
  turn: 2,
  known: { address: null, scope: "kitchen and living room" },
};

describe("the re-ask after a refusal narrows to the zip and says why", () => {
  it("asks for the zip, with the reason, when we have asked and hold nothing", () => {
    const out = renderMessage({ ...base, addressAskedBefore: true });
    expect(out).toMatch(/zip/i);
    expect(out).toMatch(/accurate/i);
  });

  /**
   * The bug as it actually read. Naming the sentence is fair here because it
   * is a TEMPLATE we still ship for the first ask — this asserts it does not
   * come back on the second, not that the string was deleted.
   */
  it("does not repeat the plain address question", () => {
    const out = renderMessage({ ...base, addressAskedBefore: true });
    expect(out).not.toMatch(/what address should we have the estimator go to/i);
    expect(out).not.toMatch(/where's the property located/i);
  });

  it("leaves the FIRST ask alone — it has no reason to apologise yet", () => {
    const out = renderMessage({ ...base, turn: 0, addressAskedBefore: false });
    expect(out).toMatch(/address/i);
    expect(out).not.toMatch(/at least need the zip/i);
  });

  /** Whatever the turn, a re-ask is a re-ask: the wording must not rotate. */
  it.each([1, 2, 3, 4, 5])("says the same thing on turn %i", (turn) => {
    const out = renderMessage({ ...base, turn, addressAskedBefore: true });
    expect(out).toMatch(/at least need the zip code to price it accurately/i);
  });

  it("says it in Spanish too", () => {
    const out = renderMessage({ ...base, addressAskedBefore: true, language: "es" } as never);
    expect(out).toMatch(/código postal/i);
    expect(out).toMatch(/cotizarlo bien/i);
  });

  /**
   * ORDERING, which is the whole reason this is checked after the other two.
   * Holding half an address, or being on the second property, is the more
   * specific fact and keeps its own wording — a customer who gave "44 Elm Ave"
   * must still be asked for the zip of THAT, not told we need one at minimum.
   */
  it("yields to a partial address, which is the more specific case", () => {
    // turn 0, where the gap table NAMES the address it already holds. At a
    // later turn both branches say "we need the zip" and the assertion would
    // pass whichever one won, which is no test at all.
    const out = renderMessage({
      ...base, turn: 0, addressAskedBefore: true, addressGap: "zip",
      known: { address: "44 Elm Ave", scope: "kitchen" },
    } as never);
    expect(out).toContain("44 Elm Ave");
  });

  it("yields to the second-property ask", () => {
    const out = renderMessage({ ...base, addressAskedBefore: true, secondProperty: true } as never);
    expect(out).toMatch(/second|other/i);
  });
});

/**
 * AND THE DESTINATION. These are the rules the prompt now has to agree with;
 * if either flips, the guidance in agent-run.ts is telling the model to do
 * something that gets refused.
 */
describe("a phone quote is the end of the flow, not a way out of it", () => {
  const act = (intent: string) => ({ intent, confidence: 0.97, freeText: "" });

  it("refuses phone_pricing while contact has never been asked for", () => {
    const res = validateAction(act("phone_pricing"), {
      priorIntents: ["ask_project_details", "ask_address"],
      scopeFromCustomer: true,
    } as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("details_never_collected");
  });

  /** THE LEGAL MOVE. Without this the two rules have nothing between them. */
  it("allows asking for contact first, even with no address at all", () => {
    const res = validateAction(act("ask_contact"), {
      priorIntents: ["ask_project_details", "ask_address"],
      lastIntent: "ask_address",
      scopeFromCustomer: true,
    } as never);
    expect(res.ok).toBe(true);
  });

  it("and then allows the phone price", () => {
    const res = validateAction(act("phone_pricing"), {
      priorIntents: ["ask_project_details", "ask_address", "ask_contact"],
      scopeFromCustomer: true,
    } as never);
    expect(res.ok).toBe(true);
  });
});
