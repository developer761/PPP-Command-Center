import { describe, it, expect } from "vitest";
import { validateAction } from "@/lib/messaging/agent-output";

/**
 * A35 ("Never offer to tentatively hold, pencil in or provisionally book an
 * appointment") and A18 ("Do not suggest customers go to other companies")
 * were both live, both critical, and neither was checked on a live reply.
 *
 * A35 LOOKED enforced, which is how it survived: "I can pencil you in for
 * Tuesday" is refused — for invented_availability, catching the DAY NAME,
 * not the promise. Strip the day and the promise sailed through. A rule
 * enforced by coincidence holds only until the coincidence stops.
 *
 * A18 was enforced on FAQ content since the FAQ screen was built — an admin
 * cannot SAVE an answer naming a competitor — and never on what the bot
 * actually sends. Guarded at the saving end, open at the sending end.
 */
const ctx = {
  flowStage: undefined,
  knownFields: {},
  templateAsks: () => false,
  customerMessages: [],
} as never;

const verdict = (freeText: string) =>
  validateAction({ intent: "discard", confidence: 0.97, freeText }, ctx);

describe("A35 — the bot never offers to hold a slot", () => {
  /**
   * The bot has no calendar; the office owns it. A customer told their slot
   * is held believes they have an appointment that does not exist, and finds
   * out by waiting in. It is the most expensive sentence the bot can send.
   */
  it.each([
    "I'll pencil you in",
    "Let me reserve that slot for you",
    "I'll hold it for you",
    "I can put you down provisionally",
    "We'll tentatively book it",
    "I'll block off that time",
    "I'll save that spot for you",
    "Le aparto la cita",
  ])("refuses %j", (t) => {
    const v = verdict(t);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("offered_to_hold");
  });

  /** The line it must not cross: ordinary English using the same verbs. */
  it.each([
    "Hold on one moment while I check.",
    "I'll hold off until you confirm.",
    "We reserve the right to adjust after seeing it.",
    "Happy to help with that.",
  ])("allows %j", (t) => {
    expect(verdict(t).ok).toBe(true);
  });
});

describe("A18 — the bot never points them at another company", () => {
  it.each([
    "You might try another painting company",
    "Honestly, a different contractor may be cheaper",
    "You could call another company about that",
    "Puede probar con otra empresa",
  ])("refuses %j", (t) => {
    const v = verdict(t);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("named_another_company");
  });

  /** Saying what WE are, and ordinary uses of "another", must survive. */
  it.each([
    "We are a painting company based in Garden City.",
    "That would need another coat of paint.",
    "Another room is no problem.",
    "The estimator will confirm that with you directly.",
  ])("allows %j", (t) => {
    expect(verdict(t).ok).toBe(true);
  });
});
