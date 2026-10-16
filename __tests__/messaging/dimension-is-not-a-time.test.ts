import { describe, it, expect } from "vitest";
import { requestedTime } from "@/lib/messaging/appointment-time";
import { validateAction } from "@/lib/messaging/agent-output";
import { renderMessage } from "@/lib/messaging/render";

/**
 * A WALL'S MEASUREMENT READ AS AN APPOINTMENT TIME. 2026-10-16.
 *
 * requestedTime("18.5 by 9.5 wall") returned 9:00. Besides being wrong, that
 * mattered at A29: a requested time counts as answered by the collecting
 * turns ("I'll check the calendar for that time."), so "how much for an
 * 18.5 by 9.5 wall?" let ask_address through with the price question
 * ignored — and the renderer then led with a calendar line nobody asked for.
 */
describe("a dimension is not a time", () => {
  it.each([
    "18.5 by 9.5 wall",
    "it's a 12 by 10 bedroom",
    "the room is 10 ft by 12",
    "two walls, 14' by 8",
    "a 9.5 by 11 hallway",
  ])("reads no time in %j", (t) => {
    expect(requestedTime(t)).toBeNull();
  });

  /** CONTROL: the times this branch exists for still parse. */
  it.each([
    ["can you come by 3?", 15],
    ["around 10 works", 10],
    ["I'll be home by 6 in the evening", 18],
    ["at 12 Marchmont Ave, can you come at 3?", 15],
  ])("still reads %j", (t, hour) => {
    expect(requestedTime(t)?.hour).toBe(hour);
  });

  it("does not count the dimension as an answered question (validator + renderer)", () => {
    const customerText = "how much to paint an 18.5 by 9.5 wall?";
    const v = validateAction(
      { intent: "ask_address", confidence: 0.97 },
      { customerText, priorIntents: ["ask_project_details"], knownFields: { inquiryScope: "wall" }, scopeFromCustomer: true } as never,
    );
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("question_left_unanswered");
    const out = renderMessage({ intent: "ask_address", turn: 0, customerText, known: { scope: "wall" } });
    expect(out).not.toMatch(/calendar/i);
  });
});
