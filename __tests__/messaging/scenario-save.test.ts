import { describe, it, expect } from "vitest";
// Not from simulator.ts: that is "use server" and may export only async
// functions. Putting it there first was caught by `npm run build`, which is
// the one gate that sees it.
import { composeNote } from "@/lib/messaging/scenario-note";

/**
 * A RATER'S WORDS WERE BEING THROWN AWAY ON SAVE.
 *
 * Kate's first session, 2026-10-06. She marked a turn Wrong and filled all
 * three boxes — what it got right, where it fell short, and the correction,
 * which the screen itself calls "the most useful thing on the sheet". Then she
 * pressed Save as a test and got a success message.
 *
 * The row that reached the database read `verdict: "wrong"` with an EMPTY
 * `verdict_note`. `sms_scenario_turns` has one text column and nothing was
 * writing her words into it, so the save stored the mark and discarded the
 * teaching. Checked against production afterwards: her saved turn really does
 * hold nothing but the verdict.
 *
 * What hid it: "Send to training" — the OTHER button on the same panel —
 * already used all three fields, so the data was plainly being collected and
 * only one of the two paths kept it.
 */
describe("every box a rater filled in survives the save", () => {
  it("keeps all three, labelled so they stay separable", () => {
    const note = composeNote({
      didWell: "Attempting to confirm scope from known information",
      shortfall: "instead of restating the customer's scope, it inserted it word for word",
      shouldHave: 'ideally it would restate the scope like "Just to confirm, you\'re looking to paint 1-2 rooms. Is that right?"',
    });
    expect(note).toContain("Got right: Attempting to confirm scope");
    expect(note).toContain("Fell short: instead of restating");
    expect(note).toContain("Should have: ideally it would restate");
  });

  /** The correction is the one that must never be lost. */
  it("keeps the correction even when it is the only thing written", () => {
    const note = composeNote({ shouldHave: "restate it in our own words" });
    expect(note).toBe("Should have: restate it in our own words");
  });

  it.each([
    ["didWell", { didWell: "right call on the off-site quote" }],
    ["shortfall", { shortfall: "read clumsily" }],
    ["shouldHave", { shouldHave: "say it shorter" }],
  ])("keeps %s on its own", (_label, input) => {
    expect(composeNote(input)).toBeTruthy();
  });

  /** An ungraded turn stays empty rather than storing bare headings. */
  it.each([{}, { didWell: "" }, { shortfall: "   " }, { shouldHave: "\n" }])(
    "writes nothing when nothing was typed: %j", (input) => {
      expect(composeNote(input)).toBeNull();
    }
  );

  /**
   * The older single-box note still works, so rows saved before the three
   * boxes existed do not change meaning.
   */
  it("carries the plain note through", () => {
    expect(composeNote({ verdictNote: "good but terse" })).toBe("good but terse");
  });

  it("keeps both when a plain note and the boxes are present", () => {
    const note = composeNote({ shortfall: "too long", verdictNote: "also a typo" });
    expect(note).toContain("Fell short: too long");
    expect(note).toContain("also a typo");
  });
});
