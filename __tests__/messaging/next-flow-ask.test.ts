import { describe, it, expect } from "vitest";
import { renderMessage } from "@/lib/messaging/render";
import { validateAction } from "@/lib/messaging/agent-output";
import { tooManyAsks } from "@/lib/messaging/one-ask";

/**
 * THE REPLACEMENT ASK WENT ROUND THE RULE THAT REFUSES IT.
 *
 * When the flow's own availability question is stripped as too early, a
 * replacement is appended so the turn does not read as a sign-off. The first
 * version chose it from `flowStage`, which is stageFromIntents(priorIntents) —
 * the highest leg the BOT has asked about, not what we actually hold.
 *
 * The ordinary PPP web-form lead arrives with Inquiry Notes, an address and an
 * email on the record and flowStage 0. So it asked a lead whose notes say what
 * they want painted what they were looking to have painted, and asked for an
 * address that was already on file — both of which ASK_SUPERSEDED_BY refuses
 * outright when the AGENT chooses them. Appending the template walked around
 * the validator: a refused intent going out as part of another one.
 *
 * Newly exposed rather than theoretical — defer_to_estimator joined LOW_STAKES
 * the same day, so these turns autosend at 0.85 with nobody reading them.
 */
const lead = (known: Record<string, string>, over: Record<string, unknown> = {}) => ({
  intent: "defer_to_estimator" as const,
  flowStage: 0, track: "new_lead" as const, turn: 2,
  customerText: "how much to paint a 12x14 bedroom?",
  known, ...over,
});

describe("the replacement ask is for something we do not already have", () => {
  it("does not ask what they want painted when the Inquiry Notes say so", () => {
    const out = renderMessage(lead({ scope: "paint a 12x14 bedroom", address: "44 Elm Ave", email: "a@b.com" }) as never);
    expect(out).not.toMatch(/looking to have painted|what sort of project|what's the project/i);
  });

  it("does not ask for an address that is on file", () => {
    const out = renderMessage(lead({ scope: "exterior", address: "44 Elm Ave, Hicksville NY 11801", email: "a@b.com" }) as never);
    expect(out).not.toMatch(/address/i);
  });

  it("does not ask for contact details it holds", () => {
    const out = renderMessage(lead({ scope: "exterior", address: "44 Elm Ave", email: "a@b.com" }) as never);
    expect(out).not.toMatch(/name and email|best email/i);
  });

  it("asks for the project when nothing is on file", () => {
    const out = renderMessage(lead({}) as never);
    expect(out).toMatch(/looking to have painted|what's the project|sort of project/i);
  });

  it("asks for the address when that is the first thing missing", () => {
    const out = renderMessage(lead({ scope: "exterior" }) as never);
    expect(out).toMatch(/address/i);
  });

  it("asks for contact when scope and address are both in hand", () => {
    const out = renderMessage(lead({ scope: "exterior", address: "44 Elm Ave" }) as never);
    expect(out).toMatch(/name and email|email/i);
  });

  /**
   * A SECOND PROPERTY REOPENS THE ADDRESS LEG. They have told us about a place
   * we have no address for, which is the same exception renderBody makes.
   */
  it("asks for the address again when they mention a second property", () => {
    const out = renderMessage(lead(
      { scope: "exterior", address: "44 Elm Ave", email: "a@b.com" },
      { secondProperty: true },
    ) as never);
    expect(out).toMatch(/address/i);
  });

  /**
   * AND WHEN WE HOLD EVERYTHING, THE STRIP IS UNDONE RATHER THAN LEFT EMPTY.
   *
   * There is nothing earlier to ask for, so availability really is the next
   * leg and the only thing that said otherwise was flowStage. Appending
   * nothing would leave the dead end the branch exists to close: an answer
   * with no question and the next move the customer's to make or not.
   */
  it("keeps the availability question when every earlier leg is done", () => {
    const out = renderMessage(lead({ scope: "exterior", address: "44 Elm Ave", email: "a@b.com" }) as never);
    expect(out).toMatch(/\?/);
    expect(out).toMatch(/days|times|when/i);
  });

  /**
   * AND IT DOES NOT RE-ASK A LEG ALREADY PUT TO THEM.
   *
   * flowStage is the wrong thing to pick the ask FROM, which was the bug, but
   * it is still the only record of what the bot has already asked. With
   * nothing on file at flowStage 1, the project question has been asked and
   * went unanswered; asking it again in the same breath as another intent's
   * answer is how a thread starts repeating itself. So the address is next.
   */
  it("moves on to the next leg rather than repeating one already asked", () => {
    const out = renderMessage(lead({}, { flowStage: 1 }) as never);
    expect(out).toMatch(/address/i);
    expect(out).not.toMatch(/looking to have painted|hoping to have painted/i);
  });

  /**
   * But a leg BEHIND the flow that is still unmet is asked rather than never
   * asked, once there is nothing ahead of it left to ask for.
   */
  it("falls back to an earlier unmet leg when nothing later is outstanding", () => {
    const out = renderMessage(lead(
      { address: "44 Elm Ave", email: "a@b.com" },
      { flowStage: 2 },
    ) as never);
    expect(out).toMatch(/painted|project/i);
  });
});

describe("the appended ask does not stack a second opener", () => {
  /**
   * The comment promised "the plainest variant rather than the turn-rotated
   * one" and the code indexed by turn, so a whole message was bolted on,
   * opener and all:
   *
   *   "That's one for the estimator, and they'll go through it with you.
   *    Happy to help. What's the project you're looking to get done?"
   *
   * Two openers in one SMS with the rapport in the middle — the shape
   * OPENS_WITH_ACKNOWLEDGEMENT exists to stop, and invisible to it because
   * this concatenation happens after renderBody has finished.
   */
  /** The pleasantries the SAYS variants open with, which used to ride along. */
  const PLEASANTRY = /^(?:happy to help|sure thing|of course|got it|perfect|great|no problem|absolutely|sure)\b/i;

  it.each([0, 1, 2, 3])("renders one ask and one opener at turn %i", (turn) => {
    const out = renderMessage(lead({}, { turn }) as never);
    expect(tooManyAsks(out), `more than one ask: ${out}`).toBeFalsy();
    /**
     * Two sentences: what the intent says, then the ask. A third means a whole
     * template was bolted on rather than its question — the bug — and the
     * pleasantry check names the specific words that used to arrive mid-SMS.
     */
    const sentences = out.split(/(?<=[.?!])\s+/).filter((s) => s.trim());
    expect(sentences.length, `more than the template plus one ask: ${out}`).toBeLessThanOrEqual(2);
    for (const s of sentences.slice(1)) {
      expect(PLEASANTRY.test(s.trim()), `rapport arriving mid-message: ${out}`).toBe(false);
    }
    expect(sentences[sentences.length - 1]).toMatch(/\?$/);
  });

  it("never appends more than one question", () => {
    for (const turn of [0, 1, 2, 3]) {
      const out = renderMessage(lead({}, { turn }) as never);
      expect((out.match(/\?/g) ?? []).length, out).toBeLessThanOrEqual(1);
    }
  });
});

/**
 * THE PARITY THAT WAS BROKEN. Whatever this appends, the validator must be
 * willing to let the agent CHOOSE it for the same conversation — otherwise the
 * two disagree about the same customer and the append is the way round.
 */
describe("what is appended is an ask the validator would also allow", () => {
  it.each([
    ["everything on file", { scope: "exterior", address: "44 Elm Ave", email: "a@b.com" }],
    ["address on file", { scope: "exterior", address: "44 Elm Ave" }],
    ["nothing on file", {}],
  ])("%s", (_label, known) => {
    const out = renderMessage(lead(known) as never);
    const asksAddress = /address/i.test(out);
    if (!asksAddress) return;
    // If the rendered turn asks for an address, the validator must agree an
    // address is still owed.
    const v = validateAction(
      { intent: "ask_address", freeText: "", confidence: 0.9 },
      { customerText: "how much to paint a 12x14 bedroom?", known } as never
    );
    expect(v.ok, `the turn asked for an address the validator refuses: ${out}`).toBe(true);
  });
});
