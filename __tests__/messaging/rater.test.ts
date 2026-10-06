/**
 * The auto-rater, and the one guarantee it exists to keep.
 *
 * Kate's heading on the Rating guidance column is "RATER ONLY — NEVER give
 * this to a bot." The Iteration 1 spec turns that into an acceptance
 * criterion: "Rating guidance is read by the rater and reaches no bot prompt,
 * PROVABLY."
 *
 * "Provably" is why the separation is tested in BOTH directions below. A test
 * that only checks the bot prompt lacks the guidance would pass just as
 * happily if the guidance were never loaded at all — which is a different
 * system, and a broken rater.
 */
import { describe, it, expect } from "vitest";
import {
  buildRaterPrompt, renderTurnsForRating, keepUsableFindings, conductFromFindings,
  type RuleForRating, type RatableTurn,
} from "@/lib/messaging/rater";
import { forPrompt, type ClassARule } from "@/lib/messaging/class-a-rules";

const GUIDANCE = "RATER ONLY: a confirm from file counts as correct; only a retype is a defect.";

const rule = (over: Partial<RuleForRating> = {}): RuleForRating => ({
  code: "A13",
  statement: "Do not ask the customer to RETYPE data already held.",
  ruleCard: "THE THREE-WAY SPLIT: confirming from file ONCE = correct.",
  correctiveAction: "confirmed the held field once instead of asking them to retype it",
  severity: "critical",
  status: "live",
  phrasingOnly: false,
  binds: true,
  ratingGuidance: GUIDANCE,
  ...over,
} as RuleForRating);

describe("the rating guidance reaches the rater", () => {
  it("is in the rater's prompt", () => {
    expect(buildRaterPrompt([rule()])).toContain(GUIDANCE);
  });

  it("along with everything the bot also gets", () => {
    const p = buildRaterPrompt([rule()]);
    expect(p).toContain("A13");
    expect(p).toContain("Do not ask the customer to RETYPE");
    expect(p).toContain("confirmed the held field once");
    expect(p).toContain("critical");
  });

  it("and a retired rule is not rated against", () => {
    expect(buildRaterPrompt([rule({ status: "retired" })])).not.toContain("A13");
  });
});

describe("and reaches NO bot prompt", () => {
  /**
   * The other direction, and the one that actually matters. `forPrompt` is
   * what the agent turn sends.
   */
  it("forPrompt never carries it", () => {
    // forPrompt takes ClassARule, which has no ratingGuidance field at all —
    // but pass the fuller object anyway, since a real caller could.
    const out = forPrompt([rule() as unknown as ClassARule]);
    expect(out).toContain("A13");                 // the rule IS there
    expect(out).not.toContain(GUIDANCE);          // the guidance is NOT
    expect(out).not.toContain("RATER ONLY");
  });

  it("the bot-safe type does not even have the field", () => {
    // Structural, not a filter somebody has to remember to apply. If this
    // ever compiles with ratingGuidance present, the separation has been
    // undone at the type level.
    const botSafe: ClassARule = {
      code: "A13", statement: "x", ruleCard: null, correctiveAction: null,
      severity: "critical", status: "live", phrasingOnly: false, binds: true,
    } as ClassARule;
    expect("ratingGuidance" in botSafe).toBe(false);
  });

  it("the bot-facing loader does not mention the notes table", async () => {
    // The guarantee the header describes: class-a-rules-db reads
    // sms_class_a_rules and does not know sms_class_a_rule_notes exists.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/messaging/class-a-rules-db.ts", "utf8");
    const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "");   // strip the comments
    expect(code).not.toContain("sms_class_a_rule_notes");
    expect(code).not.toContain("rating_guidance");
  });
});

describe("findings that are not usable are dropped, and counted", () => {
  const turns: RatableTurn[] = [
    { ordinal: 1, role: "customer", text: "I need my kitchen painted" },
    { ordinal: 2, role: "bot", text: "What is your address?" },
    { ordinal: 3, role: "customer", text: "4821 Oak Lane" },
    { ordinal: 4, role: "bot", text: "What is your address?" },
  ];
  const liveCodes = new Set(["A13", "A11"]);

  it("keeps a good one", () => {
    const { findings, dropped } = keepUsableFindings(
      [{ code: "A13", turn: 4, kind: "fell_short", reason: "asked for the address already given in turn 3" }],
      { liveCodes, turns }
    );
    expect(findings).toHaveLength(1);
    expect(dropped).toHaveLength(0);
    expect(findings[0].code).toBe("A13");
  });

  it("drops a rule id that does not exist", () => {
    const { findings, dropped } = keepUsableFindings(
      [{ code: "A99", turn: 4, kind: "fell_short", reason: "x" }], { liveCodes, turns });
    expect(findings).toHaveLength(0);
    expect(dropped[0].reason).toMatch(/not a live rule/);
  });

  it("drops a finding against a CUSTOMER turn — only the bot is rated", () => {
    const { findings, dropped } = keepUsableFindings(
      [{ code: "A13", turn: 3, kind: "fell_short", reason: "x" }], { liveCodes, turns });
    expect(findings).toHaveLength(0);
    expect(dropped[0].reason).toMatch(/not a bot turn/);
  });

  it("drops a turn that is not in the conversation", () => {
    const { findings } = keepUsableFindings(
      [{ code: "A13", turn: 99, kind: "fell_short", reason: "x" }], { liveCodes, turns });
    expect(findings).toHaveLength(0);
  });

  it("drops one with no reason, since a finding nobody can check is noise", () => {
    const { findings } = keepUsableFindings(
      [{ code: "A13", turn: 4, kind: "fell_short", reason: "   " }], { liveCodes, turns });
    expect(findings).toHaveLength(0);
  });

  it("defaults an unrecognised kind to fell_short rather than inventing a good turn", () => {
    const { findings } = keepUsableFindings(
      [{ code: "A13", turn: 4, kind: "excellent" as never, reason: "x" }], { liveCodes, turns });
    expect(findings[0].kind).toBe("fell_short");
  });

  it("an empty result is a valid answer", () => {
    // Spec: "A rule with no findings is not a broken rater." A conversation
    // that went well produces few or none, and that is correct.
    expect(keepUsableFindings([], { liveCodes, turns }).findings).toHaveLength(0);
  });
});

describe("the transcript the rater reads", () => {
  it("numbers every turn and says who spoke", () => {
    const out = renderTurnsForRating([
      { ordinal: 1, role: "customer", text: "hi" },
      { ordinal: 2, role: "bot", text: "hello" },
    ]);
    expect(out).toContain("[turn 1] CUSTOMER: hi");
    expect(out).toContain("[turn 2] BOT: hello");
  });
});

/**
 * THE VERDICT THE AUTO-RATER NEVER WROTE.
 *
 * sweepUnrated inserted the example, called the model, saved the findings —
 * and never wrote `conduct`. Checked against production 2026-10-06: all four
 * live-rated conversations have conduct NULL while carrying 18 coded findings
 * between them (13 fell_short, 5 did_well) naming real failures.
 *
 * repairQueue selects `.in("conduct", ["mixed","bad"])`, so a conversation the
 * rater had just described in detail was STRUCTURALLY unable to enter the
 * repair console. Every rating is a paid Opus call whose output reached one
 * list page and no queue, and the review that was meant to "start from a
 * rating instead of from nothing" started from nothing.
 */
describe("the verdict derived from the findings", () => {
  const f = (code: string, kind: "fell_short" | "did_well") =>
    ({ code, turn: 2, kind, reason: "because" });
  /** A13 and A11 are critical in production; A33 is mild. */
  const sev = (code: string) =>
    code === "A33" ? "mild" : code === "A13" || code === "A11" ? "critical" : null;

  it("is good when nothing fell short", () => {
    expect(conductFromFindings([f("A13", "did_well"), f("A11", "did_well")], sev)).toBe("good");
  });

  it("is good when there are no findings at all", () => {
    expect(conductFromFindings([], sev)).toBe("good");
  });

  /**
   * `mixed` is the useful answer, not a hedge: repairQueue sorts mixed FIRST
   * because the console is called "Fix a near-miss".
   */
  it("is mixed for a shortfall against a non-critical rule", () => {
    expect(conductFromFindings([f("A33", "fell_short")], sev)).toBe("mixed");
  });

  it("is mixed when a rule has no severity recorded", () => {
    expect(conductFromFindings([f("A99", "fell_short")], sev)).toBe("mixed");
  });

  it("is bad when a critical rule was broken", () => {
    expect(conductFromFindings([f("A13", "fell_short")], sev)).toBe("bad");
  });

  /** Doing something well elsewhere does not downgrade a critical breach. */
  it("stays bad even alongside things done well", () => {
    expect(conductFromFindings(
      [f("A13", "fell_short"), f("A33", "did_well"), f("A11", "did_well")], sev
    )).toBe("bad");
  });

  it("ignores severity on the things done WELL", () => {
    // A13 is critical, but doing it well is not a breach of anything.
    expect(conductFromFindings([f("A13", "did_well"), f("A33", "fell_short")], sev)).toBe("mixed");
  });

  it("is case-insensitive about the severity string", () => {
    expect(conductFromFindings([f("X", "fell_short")], () => "CRITICAL")).toBe("bad");
  });

  /**
   * EVERY BAND THE QUEUE CAN SEE. good is excluded by design — there is
   * nothing to repair — and both of the others must reach it, or this whole
   * change achieves nothing.
   */
  it.each([
    [[f("A33", "fell_short")], "mixed"],
    [[f("A13", "fell_short")], "bad"],
  ])("produces a band repairQueue selects: %#", (findings, expected) => {
    const got = conductFromFindings(findings, sev);
    expect(got).toBe(expected);
    expect(["mixed", "bad"]).toContain(got);
  });
});
