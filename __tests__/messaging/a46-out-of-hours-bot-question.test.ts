import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  disclosureMove, applyDisclosure,
  DISCLOSURE_IN_HOURS, DISCLOSURE_OUT_OF_HOURS, DISCLOSURE_IN_HOURS_ES, DISCLOSURE_OUT_OF_HOURS_ES,
} from "@/lib/messaging/disclosure";
import { renderMessage, OPT_OUT_DISCLOSURE } from "@/lib/messaging/render";
import { validateAction } from "@/lib/messaging/agent-output";
import { stripComments } from "../helpers/strip-comments";

/**
 * A46 OUT OF HOURS: "IS THIS A BOT?" OFFERED A TEAM THAT HAD GONE HOME.
 * 2026-10-16.
 *
 * agent-run skipped disclosure for bot_suspected, so disclosureMove's
 * answer_out_of_hours branch was tested and never reached, and at 11pm the
 * customer got "Would you prefer to speak with a member of our team?". This
 * replays agent-run's sequence — validate, render, then the disclosure step
 * with askedIfBot taken from the intent — and pins that agent-run does the
 * same.
 */
const turn = (opts: { outOfHours: boolean; es?: boolean; isFirstOutbound?: boolean; photos?: number }) => {
  const customerText = opts.es ? "es esto un bot?" : "is this a bot?";
  const v = validateAction({ intent: "bot_suspected", confidence: 0.9 }, { customerText } as never);
  expect(v.ok, JSON.stringify(v)).toBe(true);
  const rendered = renderMessage({
    intent: "bot_suspected", turn: 0, customerText, language: opts.es ? "es" : "en",
    isFirstOutbound: opts.isFirstOutbound, photos: opts.photos,
  });
  const move = disclosureMove({ askedIfBot: true, outOfHours: opts.outOfHours, alreadyDisclosed: false });
  return applyDisclosure(move, rendered, !!opts.es);
};

describe("A46: the bot question out of hours", () => {
  it("answers with the out-of-hours line, offering nobody", () => {
    const out = turn({ outOfHours: true });
    expect(out).toContain(DISCLOSURE_OUT_OF_HOURS);
    expect(out).not.toMatch(/member of our team/);
  });

  it("does the same in Spanish", () => {
    const out = turn({ outOfHours: true, es: true });
    expect(out).toContain(DISCLOSURE_OUT_OF_HOURS_ES);
    expect(out).not.toContain(DISCLOSURE_IN_HOURS_ES);
  });

  it("keeps the STOP line and the photo thanks when it swaps the wording", () => {
    const out = turn({ outOfHours: true, isFirstOutbound: true, photos: 1 });
    expect(out).toContain(OPT_OUT_DISCLOSURE);
    expect(out).toMatch(/thanks for the photo/i);
    expect(out).toContain(DISCLOSURE_OUT_OF_HOURS);
  });

  /** CONTROL: in hours, the approved in-hours string, unchanged. */
  it("in hours, still sends the approved in-hours line", () => {
    expect(turn({ outOfHours: false })).toBe(DISCLOSURE_IN_HOURS);
  });

  it("agent-run takes askedIfBot from the intent instead of skipping bot_suspected", () => {
    const src = stripComments(readFileSync("lib/messaging/agent-run.ts", "utf8"));
    const sf = ts.createSourceFile("agent-run.ts", src, ts.ScriptTarget.Latest, true);
    expect(src).toMatch(/askedIfBot:\s*v\.action\.intent\s*===\s*"bot_suspected"/);
    expect(src).not.toMatch(/if\s*\(\s*v\.action\.intent\s*!==\s*"bot_suspected"\s*\)/);
    expect(sf.statements.length).toBeGreaterThan(0);
  });
});

describe("A46: naming a staff role is claiming to be a person", () => {
  const V = (freeText: string) =>
    validateAction({ intent: "acknowledge", confidence: 0.97, freeText }, { customerText: "who is this?" } as never);

  it.each([
    "This is Emily, I'm the office coordinator.",
    "I'm the office manager here.",
    "This is Emily, the scheduler for the team.",
    "Soy la coordinadora de la oficina.",
  ])("refuses %j", (t) => {
    const v = V(t);
    expect(v.ok === false && v.reason, t).toBe("claimed_to_be_human");
  });

  /** CONTROL: third person is true, and the approved disclosure is ours. */
  it.each([
    "The office coordinator will call you tomorrow.",
    "I'm an AI assistant, happy to help.",
    "Our estimator will take a look.",
  ])("allows %j", (t) => {
    const v = V(t);
    expect(v.ok === false && v.reason, t).not.toBe("claimed_to_be_human");
  });
});
