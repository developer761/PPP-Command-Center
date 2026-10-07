import { describe, it, expect } from "vitest";
import { scopeForReadback, renderMessage } from "@/lib/messaging/render";

/**
 * THE READIEST LEAD IN THE QUEUE COULD NOT BE ANSWERED AT ALL.
 *
 * A web-form scope is often one sentence, and somebody ready to book writes
 * the readiest one there is: "Can someone come out Monday to look at my
 * kitchen".
 *
 * A day must never be read back — doing so reads as agreeing to an
 * appointment nobody booked, which is A15 — so the readback strips any
 * sentence naming one. With a single sentence that left NOTHING, and
 * confirm_scope rendered the empty string. The turn then says nothing at all:
 * the conversation goes to a person with no draft written, nobody sees what
 * the bot meant to say, and because the intent is never recorded A3's first
 * leg stays open for the life of the conversation.
 *
 * The other intent that could satisfy that leg, ask_project_details, is
 * refused for the opposite reason — the scope IS on file. Two correct rules,
 * no legal move between them, on turn one.
 */
describe("a scope that names a day is still usable", () => {
  it("keeps the project and drops the day", () => {
    const out = scopeForReadback("Can someone come out Monday to look at my kitchen");
    expect(out).not.toBe("");
    expect(out.toLowerCase()).not.toContain("monday");
    expect(out.toLowerCase()).toContain("kitchen");
  });

  it("renders a confirmation a customer can answer", () => {
    const out = renderMessage({
      intent: "confirm_scope",
      known: { scope: "Can someone come out Monday to look at my kitchen" },
      turn: 0,
    });
    expect(out.trim()).not.toBe("");
    expect(out.toLowerCase()).not.toContain("monday");
  });

  it("still prefers whole sentences when there is one to keep", () => {
    // Unchanged behaviour: the sentence without the day survives intact.
    expect(scopeForReadback("I need the kitchen painted. Can you come Monday?"))
      .toBe("I need the kitchen painted.");
  });

  it("says nothing when there is nothing but a time", () => {
    // Better silence here than a readback that is only an appointment request.
    expect(scopeForReadback("Monday at 2pm")).toBe("");
    expect(scopeForReadback("tomorrow")).toBe("");
  });

  it("is unchanged for an ordinary scope", () => {
    expect(scopeForReadback("3 bedrooms and the hallway")).toBe("3 bedrooms and the hallway");
  });
});
