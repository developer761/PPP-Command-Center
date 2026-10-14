import { describe, it, expect } from "vitest";
import { validateAction } from "@/lib/messaging/agent-output";

/**
 * A46, critical and unambiguous: "NEVER CLAIM TO BE A PERSON."
 *
 * Nothing refused one. It was enforced in three places that all stop short
 * of the model's own words — the intent guide, the bot_suspected template
 * (a truthful constant), and disclosure.ts — and rapport is PREPENDED to the
 * template, so what actually went out was:
 *
 *   "Yes, I'm a real person! I'm an AI assistant, but I can take your
 *    project details and get you set up with an estimator."
 *
 * Self-contradicting in two sentences, with the lie first.
 *
 * ── THIS ONE REALLY HAPPENED ────────────────────────────────────────────
 *
 * Four turns in Kate's corpus, all fell_short:
 *
 *   "I'm a real person—this is Emily, the team's assistant."
 *
 * She coded them A32 (reason clause), A23 (em dash) and A29 (answered a
 * different question) — never A46. The punctuation was caught and the lie
 * was not, by the grading or by the code.
 */
const ctx = {
  flowStage: undefined,
  knownFields: {},
  templateAsks: () => false,
  customerMessages: [],
} as never;

const verdict = (freeText: string) =>
  validateAction({ intent: "bot_suspected", confidence: 0.97, freeText }, ctx);

describe("A46 — the bot never claims to be a person", () => {
  it("refuses the exact sentence that reached customers", () => {
    const v = verdict("I’m a real person—this is Emily, the team’s assistant. Happy to get you taken care of!");
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("claimed_to_be_human");
  });

  it.each([
    "Yes, I'm a real person!",
    "I'm not a bot, I'm Emily from the office",
    "Yes this is Emily, a human",
    "Of course I'm real, haha",
    "I'm a live agent here at PPP",
    "I am a real person",
    "this is a live person speaking",
    "Sí, soy una persona real",
    "No soy un bot",
  ])("refuses %j", (t) => {
    const v = verdict(t);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("claimed_to_be_human");
  });

  /**
   * FIRST PERSON IS THE WHOLE DISTINCTION, and this half matters as much.
   * The estimator IS a person; saying so is true and useful. Only the bot
   * talking about ITSELF is the lie.
   */
  it.each([
    "A real person will call you shortly.",
    "Our estimator is a real person and will walk the job with you.",
    "A live estimator handles the walkthrough.",
    "Someone from our office will reach out.",
  ])("allows a true statement about somebody else: %j", (t) => {
    expect(verdict(t).ok).toBe(true);
  });

  /** The truthful answer must never be caught by the guard against the lie. */
  it.each([
    "I'm an AI assistant, but I can help with that.",
    "I'm checking that for you now.",
    "I'm not able to quote that, the estimator will.",
    "Happy to help with that.",
  ])("allows %j", (t) => {
    expect(verdict(t).ok).toBe(true);
  });
});
