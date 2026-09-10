/**
 * Comparing a saved scenario against what the bot does now.
 *
 * Migration 195 made the call that a simulated conversation is NOT a training
 * example — "a simulated customer is somebody's idea of a customer, and
 * training on those teaches the bot to handle an imagination" — and said
 * graded scenarios become regression tests instead.
 *
 * That decision is right and the other half of it was never built, so grading
 * in the sandbox went into a table nothing read. This is the half that makes
 * it matter: replay the same customer messages, compare turn by turn, and say
 * what changed.
 *
 * Pure. The caller runs the bot and hands over both sides.
 */

export type SavedTurn = {
  ordinal: number;
  customerText: string;
  intent: string | null;
  message: string;
  verdict: "good" | "acceptable" | "wrong" | null;
  verdictNote: string | null;
  expectedIntent: string | null;
};

export type ReplayedTurn = {
  ordinal: number;
  intent: string | null;
  message: string;
};

export type TurnComparison = {
  ordinal: number;
  customerText: string;
  before: { intent: string | null; message: string; verdict: SavedTurn["verdict"] };
  after: { intent: string | null; message: string };
  /** What this means for somebody reading the result. */
  status: "fixed" | "broken" | "still_wrong" | "unchanged" | "reworded" | "changed_intent";
  note: string | null;
};

/**
 * What happened to each turn.
 *
 * The four that matter are FIXED and BROKEN — a turn graded wrong that now
 * does something different, and a turn graded good that no longer does what it
 * did. Everything else is noise a person should be able to skip past, which is
 * why rewording is called out separately from changing its mind: the same
 * decision said differently is usually fine, and a different decision usually
 * is not.
 */
export function compareTurn(saved: SavedTurn, now: ReplayedTurn | undefined): TurnComparison {
  const after = { intent: now?.intent ?? null, message: now?.message ?? "" };
  const sameIntent = saved.intent === after.intent;
  const sameMessage = saved.message.trim() === after.message.trim();

  let status: TurnComparison["status"];
  if (saved.verdict === "wrong") {
    status = sameIntent && sameMessage ? "still_wrong" : "fixed";
  } else if (saved.verdict === "good" || saved.verdict === "acceptable") {
    status = sameIntent && sameMessage ? "unchanged"
      : !sameIntent ? "broken"
      : "reworded";
  } else {
    status = sameIntent && sameMessage ? "unchanged"
      : !sameIntent ? "changed_intent"
      : "reworded";
  }

  return {
    ordinal: saved.ordinal,
    customerText: saved.customerText,
    before: { intent: saved.intent, message: saved.message, verdict: saved.verdict },
    after,
    status,
    note: saved.verdictNote,
  };
}

export type ReplaySummary = {
  turns: TurnComparison[];
  fixed: number;
  broken: number;
  stillWrong: number;
  unchanged: number;
  reworded: number;
  /** Nothing a person needs to look at. */
  clean: boolean;
};

export function summarise(turns: TurnComparison[]): ReplaySummary {
  const count = (s: TurnComparison["status"]) => turns.filter((t) => t.status === s).length;
  const broken = count("broken");
  const stillWrong = count("still_wrong");
  return {
    turns,
    fixed: count("fixed"),
    broken,
    stillWrong,
    unchanged: count("unchanged"),
    reworded: count("reworded") + count("changed_intent"),
    // Rewording is not a regression. A prompt change that says the same thing
    // differently would otherwise light up every scenario and train people to
    // ignore the result.
    clean: broken === 0 && stillWrong === 0,
  };
}

/** One line for somebody who has just changed a prompt. */
export function verdictLine(s: ReplaySummary): string {
  if (s.turns.length === 0) return "This scenario has no turns to replay.";
  if (s.broken > 0) {
    return `${s.broken} turn${s.broken === 1 ? "" : "s"} that used to be right ${s.broken === 1 ? "is" : "are"} not any more.`;
  }
  if (s.stillWrong > 0) {
    return `${s.stillWrong} turn${s.stillWrong === 1 ? "" : "s"} graded wrong still ${s.stillWrong === 1 ? "does" : "do"} the same thing.`;
  }
  if (s.fixed > 0) return `${s.fixed} turn${s.fixed === 1 ? "" : "s"} graded wrong now does something different. Worth a look.`;
  if (s.reworded > 0) return "Same decisions, different wording.";
  return "Identical to when it was saved.";
}
