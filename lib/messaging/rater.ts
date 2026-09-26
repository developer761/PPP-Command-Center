/**
 * THE AUTO-RATER.
 *
 * Iteration 1 spec: "A rater that reads a conversation turn by turn against
 * the live rules and records, for each turn, the rule it broke or
 * demonstrated and why."
 *
 * Why it exists, in the spec's words: "Rating by hand does not scale past a
 * sample, and a rule set that nobody measures drifts. Rating every Hub
 * conversation as it finishes turns review into validating a baseline rather
 * than starting from a blank page, and the human adjustment is the signal
 * that keeps the rater calibrated as rules change."
 *
 * ── THE ONE THING THIS FILE EXISTS TO GET RIGHT ─────────────────────────
 *
 * Kate's Rating guidance column is headed, in her own words, "RATER ONLY —
 * NEVER give this to a bot." The spec makes it an acceptance criterion:
 * "Rating guidance is read by the rater and reaches no bot prompt,
 * PROVABLY."
 *
 * The guarantee is structural, not a convention:
 *
 *   sms_class_a_rules       bot-safe. Every column may reach a prompt.
 *   sms_class_a_rule_notes  rater only. rating_guidance and history.
 *
 * `loadClassARules` in class-a-rules-db.ts reads the first table and does not
 * know the second exists, so `forPrompt` CANNOT carry guidance even by
 * accident. This file is the only consumer that asks for both, and it is not
 * reachable from the agent turn.
 *
 * `buildRaterPrompt` is deliberately the ONLY function that takes guidance,
 * and it is not exported to anything that builds a bot prompt. The test
 * proves both directions: guidance appears here and appears nowhere in what
 * the bot is sent.
 *
 * ── A RULE WITH NO FINDINGS IS NOT A BROKEN RATER ───────────────────────
 *
 * Spec: "A45 and A35 carry zero of both in the handover corpus because Hatch
 * had no such capability. On Hub conversations they should start producing
 * findings; on the handover corpus they should not." So an empty result for a
 * rule is a fact about the corpus, and the rater must not be tuned until it
 * produces something for every rule.
 *
 * Pure. The caller does the model call and the writing.
 */
import type { ClassARule } from "./class-a-rules";

/** One finding, in the handover shape the Rule Hub's tagged view reads. */
export type RaterFinding = {
  /** The rule id, e.g. "A13". */
  code: string;
  /** Which turn, 1-based, counting every message in the conversation. */
  turn: number;
  /** Did the bot break the rule, or demonstrate it? */
  kind: "fell_short" | "did_well";
  /** Why, in a sentence a person can check against the turn. */
  reason: string;
};

/** A rule plus the rater-only text. NEVER hand one of these to a bot. */
export type RuleForRating = ClassARule & { ratingGuidance: string | null };

export type RatableTurn = {
  /** 1-based, and it is what a finding's `turn` refers to. */
  ordinal: number;
  role: "customer" | "bot";
  text: string;
};

/**
 * The rater's system prompt.
 *
 * Carries everything the bot gets — statement, detail, corrective action,
 * severity — PLUS the rating guidance, which is the whole reason those
 * columns are stored separately. See the header.
 */
export function buildRaterPrompt(rules: readonly RuleForRating[]): string {
  const live = rules.filter((r) => r.status === "live");

  const one = (r: RuleForRating) => {
    const parts = [`${r.code} [${r.severity ?? "unrated"}] ${r.statement}`];
    if (r.ruleCard) parts.push(`  In detail: ${r.ruleCard}`);
    if (r.correctiveAction) parts.push(`  What good looks like: ${r.correctiveAction}`);
    // The rater-only half. Kate: "NEVER give this to a bot."
    if (r.ratingGuidance) parts.push(`  HOW TO RATE THIS: ${r.ratingGuidance}`);
    return parts.join("\n");
  };

  return [
    "You are rating a finished conversation between Precision Painting Plus's",
    "messaging bot and a customer, turn by turn, against the rules below.",
    "",
    "WHAT YOU PRODUCE. For each BOT turn that breaks a rule or clearly",
    "demonstrates one, a finding: the rule id, the turn number, whether it",
    "fell short or did well, and why in one sentence somebody can check",
    "against that turn.",
    "",
    "RATE THE BOT, NEVER THE CUSTOMER. A customer turn is context.",
    "",
    "A TURN CAN CARRY MORE THAN ONE FINDING, and most carry none. Do not",
    "reach for a finding on every turn — a conversation that went well",
    "produces few, and that is the correct answer.",
    "",
    "A RULE YOU NEVER CITE IS NOT A FAILURE. Some rules cover situations",
    "that did not arise in this conversation. Citing one anyway to be",
    "thorough is worse than leaving it out.",
    "",
    "QUOTE NOTHING THE CUSTOMER SAID BACK AS A REASON. Describe what the bot",
    "did wrong, not what the customer typed.",
    "",
    "THE RULES:",
    "",
    live.map(one).join("\n\n"),
  ].join("\n");
}

/** The conversation, as the rater reads it. */
export function renderTurnsForRating(turns: readonly RatableTurn[]): string {
  return turns
    .map((t) => `[turn ${t.ordinal}] ${t.role === "bot" ? "BOT" : "CUSTOMER"}: ${t.text}`)
    .join("\n");
}

/**
 * Take the model's findings and keep only the ones that are usable.
 *
 * Three things are dropped, each because a bad row here becomes a bad row in
 * the Rule Hub that somebody then has to un-pick by hand:
 *
 *   a code that is not a live rule — a hallucinated id, or one that retired
 *   a turn number that does not exist in the conversation
 *   a turn that is the CUSTOMER's, since only the bot is being rated
 *
 * Returns what survived AND what was dropped, because a rater quietly
 * discarding half its output is the thing you most want to know about.
 */
export function keepUsableFindings(
  raw: readonly Partial<RaterFinding>[],
  ctx: { liveCodes: ReadonlySet<string>; turns: readonly RatableTurn[] }
): { findings: RaterFinding[]; dropped: { reason: string; finding: unknown }[] } {
  const botTurns = new Set(ctx.turns.filter((t) => t.role === "bot").map((t) => t.ordinal));
  const findings: RaterFinding[] = [];
  const dropped: { reason: string; finding: unknown }[] = [];

  for (const f of raw) {
    const code = typeof f.code === "string" ? f.code.trim().toUpperCase() : "";
    const turn = typeof f.turn === "number" ? f.turn : NaN;
    const reason = typeof f.reason === "string" ? f.reason.trim() : "";
    const kind = f.kind === "did_well" ? "did_well" : "fell_short";

    if (!ctx.liveCodes.has(code)) { dropped.push({ reason: `not a live rule: ${code || "(none)"}`, finding: f }); continue; }
    if (!Number.isInteger(turn)) { dropped.push({ reason: "no turn number", finding: f }); continue; }
    if (!botTurns.has(turn)) { dropped.push({ reason: `turn ${turn} is not a bot turn`, finding: f }); continue; }
    if (!reason) { dropped.push({ reason: "no reason given", finding: f }); continue; }

    findings.push({ code, turn, kind, reason });
  }
  return { findings, dropped };
}

/**
 * The tool schema the model fills in.
 *
 * Constrained for the same reason the agent's output is: a rater that writes
 * prose produces findings nobody can count.
 */
export const RATER_SCHEMA = {
  type: "object" as const,
  properties: {
    findings: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          code: { type: "string" as const, description: "The rule id, e.g. A13." },
          turn: { type: "integer" as const, description: "Which turn, as numbered in the transcript." },
          kind: { type: "string" as const, enum: ["fell_short", "did_well"] },
          reason: { type: "string" as const, description: "One sentence, checkable against that turn." },
        },
        required: ["code", "turn", "kind", "reason"],
      },
    },
  },
  required: ["findings"],
};
