import { describe, it, expect } from "vitest";
import { validateAction, agreesToGoAhead, hesitatesOverTheJob } from "@/lib/messaging/agent-output";
import { renderMessage } from "@/lib/messaging/render";

/**
 * A NURTURE ACCEPTANCE WITH NOBODY ACCEPTING. 2026-10-16.
 *
 *   customer  "Not sure yet, my husband wants to get another quote"
 *   bot       accepted -> "Wonderful, I'll pass this straight to the office
 *             and they'll be in touch to get you on the schedule."
 *
 * `accepted` was refused only on a decline. Now it needs a yes, and a hedge
 * anywhere in the message beats one. The sibling `success` is refused on an
 * explicit hedge too (it follows answers like "Wednesday afternoon", which
 * carry no yes, so it cannot require one).
 */
const nurture = (customerText: string) => ({
  customerText, track: "nurture",
  knownFields: { inquiryScope: true }, addressGap: null,
  templateAsks: () => false, customerMessages: [],
}) as never;

const held = {
  inquiryScope: "living room", address: "14 Beech St Hicksville NY 11801",
  name: "Dana", email: "a@b.com", phone: "+19995551212",
};

describe("accepted needs the customer to have said yes", () => {
  it.each([
    "Not sure yet, my husband wants to get another quote",
    "We're getting a couple of other quotes first",
    "Let me think about it",
    "I need to talk to my wife about it first",
    "ok thanks for sending it",
    "how long would the job take?",
    "No estoy segura, quiero otra cotización",
  ])("refuses accepted after %j, and renders no booking", (said) => {
    const v = validateAction({ intent: "accepted", confidence: 0.97 }, nurture(said));
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("accepted_without_agreement");
  });

  it("names the right remedy for an undecided customer", () => {
    const v = validateAction({ intent: "accepted", confidence: 0.97 },
      nurture("Not sure yet, my husband wants to get another quote"));
    expect(v.ok === false && v.detail).toMatch(/still deciding/);
    // And the remedy it names is legal on that same message.
    const alt = validateAction({ intent: "schedule_follow_up", confidence: 0.97 },
      nurture("Not sure yet, my husband wants to get another quote"));
    expect(alt.ok, JSON.stringify(alt)).toBe(true);
  });

  /** CONTROL: a real yes is still a yes, and the booking line is sent. */
  it.each([
    "yes let's go ahead",
    "sounds good, book it in",
    "we'd like to proceed",
    "that works for us",
    "Let's do it!",
    "Sí, adelante",
  ])("still accepts %j and sends the booking line", (said) => {
    const v = validateAction({ intent: "accepted", confidence: 0.97 }, nurture(said));
    expect(v.ok, JSON.stringify(v)).toBe(true);
    const out = renderMessage({ intent: "accepted", turn: 1, customerText: said, track: "nurture" });
    expect(out).toMatch(/office/);
  });

  /** After the booking is confirmed the yes was already given; thanks is fine. */
  it("does not ask for a second yes once the booking is confirmed", () => {
    const v = validateAction({ intent: "accepted", confidence: 0.97 },
      { ...(nurture("I'm all set, thank you") as object), lastIntent: "accepted", priorIntents: ["accepted"] } as never);
    expect(v.ok === false && v.reason).not.toBe("accepted_without_agreement");
  });

  it("a hedge beats a yes in the same message", () => {
    expect(agreesToGoAhead("Yes, but my husband wants to get another quote first")).toBe(false);
    expect(hesitatesOverTheJob("Tuesday afternoon works")).toBe(false);
  });
});

describe("the sibling: success is not a close on somebody still deciding", () => {
  const ctx = (customerText: string) => ({
    customerText, customerMessages: ["the living room", "Wednesday afternoon works"],
    priorIntents: ["ask_project_details", "ask_address", "ask_contact", "ask_availability"],
    knownFields: held, known: held, flowStage: 4, availabilityGap: null,
  }) as never;

  it("refuses success after an explicit hedge", () => {
    const v = validateAction({ intent: "success", confidence: 0.97 },
      ctx("honestly let me think about it, we're getting another quote first"));
    expect(v.ok === false && v.reason).toBe("accepted_without_agreement");
  });

  it("still closes on availability, which carries no yes (control)", () => {
    const v = validateAction({ intent: "success", confidence: 0.97 }, ctx("Wednesday afternoon works"));
    expect(v.ok, JSON.stringify(v)).toBe(true);
    expect(renderMessage({ intent: "success", turn: 0, customerText: "Wednesday afternoon works" }))
      .toMatch(/all set/);
  });
});
