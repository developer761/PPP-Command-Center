import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { buildSystemPrompt } from "@/lib/messaging/agent-run";
import {
  parseClassARules, promptable, forPrompt, statusOf, severityOf, numberOf,
  type ClassARule,
} from "@/lib/messaging/class-a-rules";

const rule = (over: Partial<ClassARule> = {}): ClassARule => ({
  code: "A1", statement: "Never provide a quoted price", ruleCard: "Hard policy.",
  correctiveAction: "gave no price, no ballpark and no range",
  severity: "critical", status: "live", phrasingOnly: false, binds: true,
  source: "ROLE", measuredBreaches: null, changeType: "BINDING",
  lastModified: "2026-09-17", lastReRated: "2026-09-11", ...over,
});

/** Kate's real headings, bracketed audience notes and all. */
const HEADERS = [
  "#", "Rule statement  [BOT + RATER]", "Source  [reference]", "Binds?  [reference]",
  "Measured breaches  [reference]", "The rule in detail  [BOT + RATER — this is the rule card]",
  "Corrective action  [BOT + RATER]", "Phrasing-only?  [reference]",
  "History  [PROVENANCE ONLY — rendered nowhere]",
  "Rating guidance  [RATER ONLY — NEVER give this to a bot]",
  "Last modified", "Change type", "Last re-rated", "Severity when breached", "Status",
].join(",");

const csv = (...rows: string[]) => `${HEADERS}\n${rows.join("\n")}\n`;
const row = (cells: string[]) =>
  cells.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",");

describe("reading Kate's sheet", () => {
  it("finds her columns despite the bracketed audience notes", () => {
    const { rules } = parseClassARules(csv(
      row(["A1", "Never provide a quoted price", "ROLE", "Yes", "", "Hard policy.", "gave no price", "", "", "look for a number", "2026-09-17", "BINDING", "2026-09-11", "critical", "LIVE — port this"])
    ));
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      code: "A1", statement: "Never provide a quoted price",
      severity: "critical", status: "live", binds: true,
    });
  });

  it("keeps rule cards that contain commas, quotes and line breaks", () => {
    // Every awkward case in RFC 4180 is in this file: A2's card alone runs to
    // 2,800 characters with embedded newlines and quoted speech.
    const card = 'Hard policy.\n\nSAY SOMETHING LIKE: "Just a moment, I\'m checking availability.", then hand off.';
    const { rules } = parseClassARules(csv(
      row(["A2", "Validate the zip", "§2B", "Yes", "", card, "checked first", "", "", "", "2026-09-17", "BINDING", "", "critical", "LIVE — port this"])
    ));
    expect(rules[0].ruleCard).toBe(card);
  });

  it("retires anything not explicitly live", () => {
    const { rules } = parseClassARules(csv(
      row(["A5", "RETIRED 2026-09-17 — merged into A3.", "", "—", "", "", "", "", "", "", "", "", "", "", "RETIRED — never tag, never build"]),
      row(["A37", "BURNED 2026-09-10 — never use this id.", "", "—", "", "", "", "", "", "", "", "", "", "", "BURNED"])
    ));
    expect(rules.map((r) => r.status)).toEqual(["retired", "retired"]);
  });

  it("keeps retired rules rather than dropping them", () => {
    // A retired rule still explains historic gradings, and deleting it is how
    // a code gets reused by accident — A37 and A42 are explicitly BURNED.
    const { rules } = parseClassARules(csv(
      row(["A5", "RETIRED — merged into A3.", "", "—", "", "", "", "", "", "", "", "", "", "", "RETIRED — never tag, never build"])
    ));
    expect(rules).toHaveLength(1);
    expect(rules[0].code).toBe("A5");
  });

  it("refuses a live rule with no severity instead of guessing", () => {
    const { rules, problems } = parseClassARules(csv(
      row(["A9", "Summarize scope", "", "Yes", "", "", "", "", "", "", "", "", "", "", "LIVE — port this"])
    ));
    expect(rules).toHaveLength(0);
    expect(problems[0].why).toMatch(/no severity/);
  });

  it("reports a duplicated code rather than letting it overwrite a rule", () => {
    const { rules, problems } = parseClassARules(csv(
      row(["A1", "First", "", "Yes", "", "", "", "", "", "", "", "", "", "critical", "LIVE — port this"]),
      row(["A1", "Second", "", "Yes", "", "", "", "", "", "", "", "", "", "critical", "LIVE — port this"])
    ));
    expect(rules).toHaveLength(1);
    expect(rules[0].statement).toBe("First");
    expect(problems[0].why).toMatch(/duplicate code A1/);
  });

  it("reads Binds? even when it carries a trailing explanation", () => {
    const { rules } = parseClassARules(csv(
      row(["A8", "The covered list", "", "Yes · PROHIBITION - no good example is possible", "", "", "", "", "", "", "", "", "", "critical", "LIVE — port this"])
    ));
    expect(rules[0].binds).toBe(true);
  });

  it("treats an em dash in Binds? as not binding", () => {
    const { rules } = parseClassARules(csv(
      row(["A5", "RETIRED", "", "—", "", "", "", "", "", "", "", "", "", "", "RETIRED — never tag"])
    ));
    expect(rules[0].binds).toBe(false);
  });

  it("says so when the file is not her sheet at all", () => {
    const { rules, problems } = parseClassARules("name,email\nBob,bob@example.com\n");
    expect(rules).toHaveLength(0);
    expect(problems.map((p) => p.why).join(" ")).toMatch(/no column for/);
  });
});

/**
 * THE ONE THAT MATTERS MOST.
 *
 * Kate's own heading: "Rating guidance [RATER ONLY — NEVER give this to a
 * bot]". It tells a human how to judge a breach, so giving it to the model
 * teaches it to argue with its own grader.
 */
describe("the rater-only column never reaches the model", () => {
  const GUIDANCE = "RATER: mark critical if a number appears anywhere in the thread";
  const parsed = () => parseClassARules(csv(
    row(["A1", "Never provide a quoted price", "ROLE", "Yes", "", "Hard policy.", "gave no price", "", "merged from A4", GUIDANCE, "", "", "", "critical", "LIVE — port this"])
  ));

  it("is parsed into a separate object, not onto the rule", () => {
    const { rules, notes } = parsed();
    // Not "the rule has a field we remember not to select" — the rule object
    // does not carry the value at all.
    expect(JSON.stringify(rules[0])).not.toContain("RATER:");
    expect(notes[0].ratingGuidance).toBe(GUIDANCE);
  });

  it("is absent from the prompt built from those rules", () => {
    const { rules } = parsed();
    expect(forPrompt(rules)).not.toContain("RATER:");
    expect(forPrompt(rules)).not.toContain(GUIDANCE);
  });

  it("keeps provenance out of the prompt too", () => {
    const { rules, notes } = parsed();
    expect(forPrompt(rules)).not.toContain("merged from A4");
    expect(notes[0].history).toBe("merged from A4");
  });
});

describe("what the model is actually told", () => {
  const rules = [
    rule({ code: "A1", severity: "critical", statement: "Never provide a quoted price" }),
    rule({ code: "A21", severity: "mild", statement: "Tone: friendly, casual, short" }),
    rule({ code: "A9", severity: "critical", statement: "Summarize scope in your own words" }),
    rule({ code: "A5", status: "retired", statement: "RETIRED — merged into A3" }),
    rule({ code: "A20", binds: false, statement: "Not a business rule" }),
  ];

  it("leaves out retired rules — Kate: never tag, never build", () => {
    expect(forPrompt(rules)).not.toContain("A5");
  });

  it("leaves out rules that do not bind the bot", () => {
    expect(forPrompt(rules)).not.toContain("A20");
  });

  it("puts the critical ones first, and says they are serious", () => {
    const out = forPrompt(rules);
    expect(out.indexOf("A1.")).toBeLessThan(out.indexOf("A21."));
    expect(out).toMatch(/SERIOUS FAILURE/);
  });

  it("orders by number, not alphabetically", () => {
    // A9 before A21 — "A10" sorts before "A9" as a string, which would put the
    // rules in an order that looks arbitrary to anybody reading the prompt.
    const out = forPrompt(rules);
    expect(out.indexOf("A1.")).toBeLessThan(out.indexOf("A9."));
    expect(numberOf("A9")).toBeLessThan(numberOf("A21"));
  });

  it("gives the corrective action, which is the useful half", () => {
    expect(forPrompt([rule()])).toMatch(/What good looks like: gave no price/);
  });

  it("is empty when there are no live rules, rather than a stray heading", () => {
    expect(forPrompt([rule({ status: "retired" })])).toBe("");
    expect(forPrompt([])).toBe("");
  });
});

describe("small helpers", () => {
  it("reads her status wording", () => {
    expect(statusOf("LIVE — port this")).toBe("live");
    expect(statusOf("RETIRED — never tag, never build")).toBe("retired");
    expect(statusOf("")).toBe("retired");
  });

  it("reads severity, and nothing else", () => {
    expect(severityOf("critical")).toBe("critical");
    expect(severityOf("mild")).toBe("mild");
    expect(severityOf("")).toBeNull();
    expect(severityOf("quite bad")).toBeNull();
  });
});

/**
 * Against Kate's ACTUAL file when it is present.
 *
 * Skipped rather than failed when it is not — the file lives in Downloads and
 * is not in the repo, so this must not break the build on anyone else's
 * machine. When it IS there, it is the only check that proves the parser
 * survives the real thing.
 */
const REAL = "/Users/karanmalhotra/Downloads/2026-09-22 hatch CLASS A RULES.csv";
describe.skipIf(!existsSync(REAL))("Kate's real file, 2026-09-22", () => {
  const parsed = () => parseClassARules(readFileSync(REAL, "utf8"));

  it("reads all 44 rules with no problems", () => {
    const { rules, problems } = parsed();
    expect(problems).toEqual([]);
    expect(rules).toHaveLength(44);
  });

  it("finds the 35 live ones she counted", () => {
    expect(parsed().rules.filter((r) => r.status === "live")).toHaveLength(35);
  });

  it("builds a prompt that fits the budget it claims", () => {
    const out = forPrompt(parsed().rules);
    // ~1,800 tokens. If this ever jumps, the cost of every single reply jumps
    // with it and somebody should decide that on purpose.
    expect(out.length).toBeGreaterThan(3_000);
    expect(out.length).toBeLessThan(12_000);
  });

  it("never leaks a word of the rater-only column into that prompt", () => {
    const { rules, notes } = parsed();
    const out = forPrompt(rules);
    const guidance = notes.map((n) => n.ratingGuidance).filter(Boolean) as string[];
    expect(guidance.length).toBeGreaterThan(10); // there is real text to leak
    for (const g of guidance) {
      // A whole sentence of it appearing anywhere in the prompt is the failure.
      const sentence = g.split(/[.\n]/).map((s) => s.trim()).filter((s) => s.length > 40)[0];
      if (sentence) expect(out, `leaked: ${sentence.slice(0, 60)}`).not.toContain(sentence);
    }
  });
});

/**
 * The rules reaching the actual system prompt.
 *
 * buildSystemPrompt takes a STRING, not the rule objects — so the type that
 * carries Kate's rater-only guidance cannot arrive there, and what does arrive
 * has already been through forPrompt, which never had it either.
 */
describe("the system prompt carries the rules", () => {
  const cfg = {
    persona_name: "Emily", persona_role: "the team's assistant",
    required_flow: ["project_details", "full_address"],
    services_included: null, services_excluded: null, offsite_rules: null,
    tone_rules: null, office_location: null, service_area_note: null,
    confidence_threshold: 0.95,
  } as Parameters<typeof buildSystemPrompt>[0];

  it("includes them when they are supplied", () => {
    const rendered = forPrompt([rule({ code: "A1", statement: "Never provide a quoted price" })]);
    const prompt = buildSystemPrompt(cfg, [], "new_lead", undefined, undefined, undefined, rendered);
    expect(prompt).toContain("A1.");
    expect(prompt).toContain("Never provide a quoted price");
  });

  it("is unchanged when there are none, rather than growing an empty heading", () => {
    const withNone = buildSystemPrompt(cfg, [], "new_lead", undefined, undefined, undefined, "");
    const without = buildSystemPrompt(cfg, [], "new_lead");
    expect(withNone).toBe(without);
    expect(withNone).not.toMatch(/THE RULES YOU ARE GRADED AGAINST/);
  });

  it("keeps them alongside the hard-nos rather than replacing them", () => {
    // The two overlap but are not the same list, and losing the hard-nos to a
    // richer rule set would be a silent downgrade.
    const rendered = forPrompt([rule({ code: "A1" })]);
    const prompt = buildSystemPrompt(cfg, ["say we are licensed in Ohio"], "new_lead", undefined, undefined, undefined, rendered);
    expect(prompt).toMatch(/NEVER, under any circumstances/);
    expect(prompt).toMatch(/licensed in Ohio/);
    expect(prompt).toContain("A1.");
  });

  it("cannot be handed the rater-only guidance, by construction", () => {
    // buildSystemPrompt's parameter is a string. There is no overload that
    // takes ClassARuleNotes, and forPrompt takes ClassARule, which has no
    // field for it. This asserts the shape of that guarantee.
    const { rules, notes } = parseClassARules(csv(
      row(["A1", "Never provide a quoted price", "", "Yes", "", "", "no price", "", "", "RATER: check every number in the thread carefully", "", "", "", "critical", "LIVE — port this"])
    ));
    const prompt = buildSystemPrompt(cfg, [], "new_lead", undefined, undefined, undefined, forPrompt(rules));
    expect(notes[0].ratingGuidance).toMatch(/^RATER:/);
    expect(prompt).not.toContain("RATER:");
  });
})

describe("how it reads to the model", () => {
  it("does not prefix Kate's past-tense corrective action with 'Instead'", () => {
    // Her column is written for a RATER marking a finished conversation —
    // "gave no price, no ballpark and no range". "Instead: gave no price"
    // reads as a garbled instruction; this reads as a passing reply.
    const out = forPrompt([rule()]);
    expect(out).not.toMatch(/Instead:/);
    expect(out).toMatch(/What good looks like:/);
  });

  it("keeps the blank line under the heading", () => {
    // A .filter(Boolean) ate it, and the section arrived as one wall of text.
    const out = forPrompt([rule()]);
    expect(out).toMatch(/marked wrong\.\n\nBREAKING ANY OF THESE/);
  });

  it("separates the mild rules from the critical ones", () => {
    const out = forPrompt([
      rule({ code: "A1", severity: "critical" }),
      rule({ code: "A21", severity: "mild", statement: "Tone: friendly" }),
    ]);
    expect(out).toMatch(/\n\nGET THESE RIGHT TOO:\n/);
  });
})
