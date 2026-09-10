import { describe, it, expect } from "vitest";
import { compareTurn, summarise, verdictLine, type SavedTurn } from "@/lib/messaging/replay";

const saved = (o: Partial<SavedTurn>): SavedTurn => ({
  ordinal: 1, customerText: "I want my cabinets painted",
  intent: "ask_address", message: "What's the address for the project?",
  verdict: null, verdictNote: null, expectedIntent: null, ...o,
});

/**
 * Migration 195 decided a simulated conversation is not a training example —
 * "training on those teaches the bot to handle an imagination" — and that
 * graded scenarios become regression tests instead. That half was never built,
 * so grading in the sandbox went into a table nothing read.
 */
describe("what changed since a scenario was graded", () => {
  it("calls a turn graded wrong that now does something else FIXED", () => {
    const c = compareTurn(
      saved({ verdict: "wrong", verdictNote: "it asked for the address twice" }),
      { ordinal: 1, intent: "confirm_address", message: "Is 1 Test St still right?" }
    );
    expect(c.status).toBe("fixed");
    expect(c.note).toBe("it asked for the address twice");
  });

  it("calls a turn graded wrong that does the same thing STILL WRONG", () => {
    const c = compareTurn(
      saved({ verdict: "wrong" }),
      { ordinal: 1, intent: "ask_address", message: "What's the address for the project?" }
    );
    expect(c.status).toBe("still_wrong");
  });

  /** The one that matters most: something that used to be right is not. */
  it("calls a turn graded good that changed its mind BROKEN", () => {
    const c = compareTurn(
      saved({ verdict: "good" }),
      { ordinal: 1, intent: "ask_availability", message: "What days suit you?" }
    );
    expect(c.status).toBe("broken");
  });

  /**
   * Rewording is not a regression. A prompt change that says the same thing
   * differently would otherwise light up every scenario and train people to
   * ignore the result.
   */
  it("does not call a reworded good turn broken", () => {
    const c = compareTurn(
      saved({ verdict: "good" }),
      { ordinal: 1, intent: "ask_address", message: "Where's the property located?" }
    );
    expect(c.status).toBe("reworded");
  });

  it("calls an identical good turn unchanged", () => {
    const c = compareTurn(
      saved({ verdict: "good" }),
      { ordinal: 1, intent: "ask_address", message: "What's the address for the project?" }
    );
    expect(c.status).toBe("unchanged");
  });

  it("handles a turn the replay never reached", () => {
    const c = compareTurn(saved({ verdict: "good" }), undefined);
    expect(c.status).toBe("broken");
    expect(c.after.message).toBe("");
  });

  it("ignores whitespace when comparing wording", () => {
    const c = compareTurn(
      saved({ verdict: "good" }),
      { ordinal: 1, intent: "ask_address", message: "  What's the address for the project?  " }
    );
    expect(c.status).toBe("unchanged");
  });

  it("notices an ungraded turn changing its mind, without calling it a regression", () => {
    const c = compareTurn(saved({ verdict: null }), { ordinal: 1, intent: "ask_contact", message: "Email?" });
    expect(c.status).toBe("changed_intent");
  });
});

describe("the result, for somebody who just changed a prompt", () => {
  const turns = (statuses: SavedTurn["verdict"][], changed: boolean[]) =>
    statuses.map((v, i) => compareTurn(
      saved({ ordinal: i + 1, verdict: v }),
      changed[i]
        ? { ordinal: i + 1, intent: "something_else", message: "different" }
        : { ordinal: i + 1, intent: "ask_address", message: "What's the address for the project?" }
    ));

  it("is clean when nothing regressed", () => {
    const s = summarise(turns(["good", "good"], [false, false]));
    expect(s.clean).toBe(true);
    expect(verdictLine(s)).toMatch(/Identical/);
  });

  it("is not clean when something broke", () => {
    const s = summarise(turns(["good", "good"], [true, false]));
    expect(s.clean).toBe(false);
    expect(s.broken).toBe(1);
    expect(verdictLine(s)).toMatch(/used to be right/);
  });

  it("is not clean while a known-wrong turn is unchanged", () => {
    const s = summarise(turns(["wrong"], [false]));
    expect(s.clean).toBe(false);
    expect(verdictLine(s)).toMatch(/still/);
  });

  it("leads with a regression even when something else was fixed", () => {
    const s = summarise(turns(["wrong", "good"], [true, true]));
    expect(s.fixed).toBe(1);
    expect(s.broken).toBe(1);
    expect(verdictLine(s)).toMatch(/used to be right/);
  });

  it("says something sensible about an empty scenario", () => {
    expect(verdictLine(summarise([]))).toMatch(/no turns/);
  });
});
