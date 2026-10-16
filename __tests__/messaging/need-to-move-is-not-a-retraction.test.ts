import { describe, it, expect } from "vitest";
import { availabilityGapAcross, retractsAvailability } from "@/lib/messaging/availability";
import { validateAction } from "@/lib/messaging/agent-output";
import { renderMessage } from "@/lib/messaging/render";

/**
 * "NEED TO MOVE" READ AS CANCELLING. 2026-10-16.
 *
 *   customer  "Tuesday morning works. Do we need to move the furniture ourselves?"
 *
 * A day, a window, and "need to move", so the bare verb withdrew the
 * availability the same message gave: the gap reopened to "both" and the
 * success close was refused. Moving furniture is the commonest thing a
 * painting customer moves. Run end to end the way agent-run does it: the gap
 * across the thread into the validator, then the turn into the renderer.
 */
const held = {
  inquiryScope: "living room", address: "14 Beech St Hicksville NY 11801",
  name: "Dana", email: "a@b.com", phone: "+19995551212",
};
const closeCtx = (thread: string[]) => ({
  customerText: thread[thread.length - 1],
  customerMessages: thread.slice(0, -1),
  priorIntents: ["ask_project_details", "ask_address", "ask_contact", "ask_availability"],
  knownFields: held,
  known: held,
  flowStage: 4,
  availabilityGap: availabilityGapAcross(thread),
}) as never;

describe("moving the furniture is not moving the appointment", () => {
  it.each([
    "Tuesday morning works. Do we need to move the furniture ourselves?",
    "Thursday afternoon is good, I have to move my car out of the driveway first",
    "Monday at 10am works, we need to change the light fixtures too, can you do that?",
    "El martes por la mañana. Tengo que mover los muebles?",
  ])("keeps the availability in %j", (text) => {
    expect(retractsAvailability(text)).toBe(false);
    expect(availabilityGapAcross([text])).toBeNull();
  });

  it("lets the close through, and the close answers them", () => {
    const thread = ["the living room", "Tuesday morning works. Do we need to move the furniture ourselves?"];
    const v = validateAction(
      { intent: "success", confidence: 0.97, freeText: "Yes, please clear the room before the crew arrives." },
      closeCtx(thread),
    );
    expect(v.ok, JSON.stringify(v)).toBe(true);
    if (!v.ok) return;
    const out = renderMessage({ intent: "success", turn: 0, freeText: v.action.freeText, customerText: thread[1], known: { scope: held.inquiryScope } });
    expect(out).toMatch(/clear the room/);
    expect(out).toMatch(/all set|everything we need/i);
  });

  /** CONTROL: a real change of plan still reopens it. */
  it.each([
    "I need to move the appointment, Tuesday won't work",
    "We have to move it to Thursday",
    "I need to push it back, Tuesday is out",
    "I have to change the day, Tuesday morning is bad now",
    "Need to reschedule Tuesday",
    "Tengo que cambiar la cita del martes",
    "Tengo que cambiar el martes",
  ])("still reopens on %j", (text) => {
    expect(availabilityGapAcross(["Tuesday afternoon works for me", text])).not.toBeNull();
  });
});
