import { describe, it, expect } from "vitest";
import { validateAction } from "@/lib/messaging/agent-output";
import { availabilityGap, availabilityIsBookable } from "@/lib/messaging/availability";
import { renderMessage } from "@/lib/messaging/render";

/**
 * A4, 98 breaches, critical. Kate's test is mechanical:
 *
 *   "A DAY IS NOT A WINDOW, AND BOTH ARE REQUIRED. 'Wed & Friday this week
 *    works best' is NOT availability collected — the estimator cannot be
 *    booked against it. THE TEST: could a person reply 'you're booked for X'
 *    without asking anything further? If they would still have to ask 'does 2
 *    to 3 work?', collection has not happened."
 *
 * And her remedy: "Where only a day is given, ask for the window and
 * collection is then complete."
 */

describe("could a person book this without asking anything further", () => {
  it("her own not-collected example", () => {
    expect(availabilityGap("Wed & Friday this week works best")).toBe("window");
    expect(availabilityIsBookable("Wed & Friday this week works best")).toBe(false);
  });

  it.each([
    "Friday morning",
    "Tuesday 2-3pm",
    "2pm Thursday",
    "I am available all day Tuesday",
    "sat afternoon",
  ])("%j is bookable", (t) => {
    expect(availabilityGap(t)).toBeNull();
  });

  it.each([
    ["next week", "window"],
    ["Monday", "window"],
    ["mornings", "day"],
    ["9am -1pm", "day"],
    ["3-5?", "day"],
  ])("%j is missing the %s", (t, missing) => {
    expect(availabilityGap(t)).toBe(missing);
  });

  it("nothing usable at all", () => {
    expect(availabilityGap("2000 sq ft interior painting")).toBe("both");
    expect(availabilityGap("")).toBe("both");
    expect(availabilityGap(null)).toBe("both");
  });
});

/**
 * "The carve-outs stand — 'anytime', 'all day', 'I'm open' IS availability
 * received, because there is nothing left to narrow." Asking these people to
 * pick a window is the redundant ask the rest of the grading is about.
 */
describe("nothing left to narrow counts as received", () => {
  it.each([
    "anytime",
    "whenever suits you",
    "any day",
    "I am open",
    "I'm open",
    "I can be flexible with an appointment to come give an estimate",
    "all day works",
    "we are free all day",
  ])("%j is availability received", (t) => {
    expect(availabilityGap(t)).toBeNull();
  });

  /**
   * FROM THE REAL CORPUS, and it was a false positive.
   *
   * "all day" on its own matched, so an apology about the past came back as a
   * bookable slot. It now needs an availability word beside it.
   */
  it("does not read an apology about yesterday as availability", () => {
    expect(availabilityGap("Hi sorry was working all day yesterday")).toBe("both");
  });
});

describe("a bare yes only counts when we had just asked", () => {
  // "A non-answer counts: 'Yes please' in reply to an availability question
  // IS availability received." The caller states whether it asked; this never
  // infers it, because a bare yes to "what days work best?" is not an answer.
  it("counts when the caller says it asked", () => {
    expect(availabilityGap("yes please", { justAskedForAvailability: true })).toBeNull();
    expect(availabilityGap("sure", { justAskedForAvailability: true })).toBeNull();
  });

  it("does not count otherwise", () => {
    expect(availabilityGap("yes please")).toBe("both");
  });

  it("does not swallow a yes that carries more", () => {
    // "Yes, but not today" is not availability received, whatever was asked.
    expect(availabilityGap("Yes, but not today", { justAskedForAvailability: true })).not.toBeNull();
  });
});

describe("the ask narrows to the half that is missing", () => {
  it("asks for the window when they named days", () => {
    const out = renderMessage({ intent: "ask_availability", availabilityGap: "window", turn: 0 });
    expect(out).toMatch(/time window|time of day/i);
    expect(out).not.toMatch(/what days/i);
  });

  it("asks for the day when they named a time", () => {
    const out = renderMessage({ intent: "ask_availability", availabilityGap: "day", turn: 0 });
    expect(out).toMatch(/which day|what day/i);
  });

  it("asks the ordinary question when we have nothing", () => {
    expect(renderMessage({ intent: "ask_availability", availabilityGap: "both", turn: 0 }))
      .toBe("What days generally work best for you?");
  });

  it("asks one thing, and never a second", () => {
    for (const gap of ["window", "day"] as const) {
      for (let turn = 0; turn < 4; turn++) {
        const out = renderMessage({ intent: "ask_availability", availabilityGap: gap, turn });
        expect((out.match(/\?/g) ?? []).length, out).toBe(1);
      }
    }
  });

  it("changes nothing for other intents", () => {
    expect(renderMessage({ intent: "ask_address", availabilityGap: "window", turn: 0 }))
      .toBe("What's the address for the project?");
  });
});

/**
 * PROVE IT CAN FAIL: the narrowing is a branch, not a coincidence.
 */
describe("the narrowing is genuinely conditional", () => {
  it("produces different words for each gap", () => {
    const words = (["window", "day", "both"] as const).map((g) =>
      renderMessage({ intent: "ask_availability", availabilityGap: g, turn: 0 })
    );
    expect(new Set(words).size).toBe(3);
  });
});

/**
 * A4 GUARDS THE CLOSE, NOT ONLY THE ASK.
 *
 * Kate: "A DAY IS NOT A WINDOW, AND BOTH ARE REQUIRED. 'Wed & Friday this week
 * works best' is NOT availability collected — the estimator cannot be booked
 * against it. THE TEST: could a person reply 'you're booked for X' without
 * asking anything further?"
 *
 * The renderer already knew this and asked "And roughly what time of day suits
 * you then?". The VALIDATOR was never given the same fact — availabilityGap
 * reached the render input and not the validate context — so `success` was
 * available on "Wednesday or Friday works best". That tells the office a job
 * is ready to book against two days and no time. Found in the simulator.
 */
describe("a close needs a bookable availability, not just a day", () => {
  const ctx = (gap: "window" | "day" | "both" | null) => ({
    track: "new_lead" as const,
    priorIntents: ["ask_project_details", "ask_address", "ask_contact", "ask_availability"],
    knownFields: { inquiryScope: true, address: true, email: true, name: true },
    availabilityGap: gap as never,
    customerText: "Wednesday or Friday works best",
  });
  const success = { intent: "success", confidence: 0.97, freeText: "" };

  it("refuses success when they named days but no window", () => {
    const v = validateAction(success, ctx("window"));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.detail).toMatch(/no time of day/i);
  });

  it("refuses it the other way round too", () => {
    const v = validateAction(success, ctx("day"));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.detail).toMatch(/no day/i);
  });

  it("ALLOWS success once the availability is whole", () => {
    expect(validateAction(success, ctx(null)).ok).toBe(true);
  });

  it("leaves the ask available, so the turn still has somewhere to go", () => {
    expect(validateAction({ ...success, intent: "ask_availability" }, ctx("window")).ok).toBe(true);
  });
});

/**
 * THE RISK THE CLOSE GUARD CREATED, held down deliberately.
 *
 * Refusing `success` on a partial availability means ANY phrasing the detector
 * does not understand now blocks a legitimate close. That is the safer
 * direction — the bot asks again rather than telling the office a job is
 * bookable when it is not — but it is only safe while the detector actually
 * recognises the ways people answer "what days work best for you?".
 *
 * So this is a sweep rather than an example: every one of these is a real
 * shape of answer, and the first column is the one that would cost a booking.
 */
describe("the close guard does not block answers a person could book", () => {
  it("lets every complete answer through", () => {
    const blocked: string[] = [];
    for (const t of [
      "Wednesday morning", "Tuesday after 2pm", "weekday mornings work best",
      "anytime", "I'm flexible", "whenever works for you", "any time is fine",
      "Monday or Tuesday, mornings preferred", "Thursday afternoon",
      "sat morning", "tomorrow morning", "this week in the afternoon",
      "mornings on Monday Wednesday or Friday", "9am Tuesday",
    ]) {
      const gap = availabilityGap(t);
      if (gap) blocked.push(`${JSON.stringify(t)} → ${gap}`);
    }
    expect(blocked, blocked.join("\n")).toEqual([]);
  });

  it("and still stops the ones an estimator cannot be booked against", () => {
    for (const t of ["Wednesday", "Wednesday or Friday", "mornings", "afternoons", "after 3pm", "weekends"]) {
      expect(availabilityGap(t), t).not.toBeNull();
    }
  });

  /**
   * "Flexible availability counts as RECEIVED" — the parity doc says so, and
   * it is the case most likely to be broken by a guard like this, because
   * "anytime" names neither a day nor a window.
   */
  it("treats flexibility as an answer, not as a gap", () => {
    for (const t of ["anytime works", "I'm flexible", "whenever suits you", "any day is fine"]) {
      expect(availabilityGap(t), t).toBeNull();
    }
  });
});
