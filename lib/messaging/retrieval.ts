/**
 * Showing the model what good looks like.
 *
 * Everything built for training — the corpus, the tags, the coverage report,
 * the grader, the simulator, Kate's four graded conversations — was
 * disconnected from the code that answers customers. No example had ever
 * reached a prompt. "The bot isn't trained whatsoever" was not an exaggeration
 * or a missing fine-tune: it was literally true, and this is the wire.
 *
 * THREE RULES, and the second one is the one that matters.
 *
 * ONE. Only scrubbed examples. A transcript that has not been through the PII
 * scrubber never goes into a prompt, whatever else is true of it.
 *
 * TWO. Good and bad are never mixed, and never presented the same way. A good
 * example is offered as something to imitate and must be approved — a human
 * has said "this is right". A bad one is offered as something to AVOID, is
 * labelled as such, and carries the grader's reason. Handing a model a pile of
 * conversations and hoping it infers which are which is how you train it to
 * reproduce the mistakes.
 *
 * THREE. Bad examples do NOT need approval, and that is deliberate rather than
 * an oversight. `approved` means "safe to copy"; a bad example is never
 * copied, so requiring it would leave the four conversations Kate actually
 * graded — every one of them bad or mixed — unable to teach the thing she
 * graded them for.
 *
 * Pure. The caller supplies the corpus.
 */
import type { Track } from "./agent-output";

export type CorpusExample = {
  id: string;
  transcript: string;
  conduct: "good" | "mixed" | "bad" | null;
  approved: boolean;
  piiScrubbed: boolean;
  /** Why the grader called it that. The most valuable field here. */
  note: string | null;
  tags: string[];
};

export type RetrievalContext = {
  /** How far the required flow has got. Decides which rule is live right now. */
  stage?: number;
  /** Photos on the customer's message. */
  mediaCount?: number;
  /** The customer reacted rather than replying. */
  isReaction?: boolean;
  track?: Track;
};

/** Rules that matter at each step of the flow. */
const STAGE_TAGS: string[][] = [
  ["flow_details", "flow_order"],
  ["flow_address", "flow_order"],
  ["flow_contact", "flow_order"],
  ["flow_availability", "flow_order"],
];

/** Rules that are live in every single turn. */
const ALWAYS = ["price_refused", "scope_refused", "one_question", "no_echo", "natural_voice"];

export function relevantTags(ctx: RetrievalContext): string[] {
  const out = new Set<string>(ALWAYS);
  if (ctx.track !== "nurture") {
    for (const t of STAGE_TAGS[Math.min(ctx.stage ?? 0, STAGE_TAGS.length - 1)]) out.add(t);
  }
  if ((ctx.mediaCount ?? 0) > 0) out.add("handled_photo");
  if (ctx.isReaction) out.add("handled_reaction");
  return [...out];
}

export type Selection = { good: CorpusExample[]; bad: CorpusExample[] };

export type Limits = {
  maxGood?: number;
  maxBad?: number;
  /** Total transcript characters across everything selected. A prompt that
   *  grows without bound costs latency on every turn and eventually truncates
   *  the instructions it was meant to support. */
  maxChars?: number;
};

const DEFAULTS: Required<Limits> = { maxGood: 3, maxBad: 2, maxChars: 6000 };

export function selectExamples(
  corpus: CorpusExample[],
  ctx: RetrievalContext,
  limits: Limits = {}
): Selection {
  const { maxGood, maxBad, maxChars } = { ...DEFAULTS, ...limits };
  const wanted = new Set(relevantTags(ctx));

  // Never anything unscrubbed, whatever else is true of it.
  const safe = corpus.filter((e) => e.piiScrubbed && e.transcript.trim());

  const score = (e: CorpusExample) => e.tags.filter((t) => wanted.has(t)).length;
  // Most relevant first; among equals, the ones carrying a written reason,
  // because a reason is what makes an example teach rather than decorate.
  const rank = (a: CorpusExample, b: CorpusExample) =>
    score(b) - score(a) || Number(!!b.note) - Number(!!a.note) || a.id.localeCompare(b.id);

  const good = safe
    .filter((e) => e.conduct === "good" && e.approved && score(e) > 0)
    .sort(rank);
  const bad = safe
    .filter((e) => (e.conduct === "bad" || e.conduct === "mixed") && score(e) > 0)
    .sort(rank);

  // Budget spent on good first: what to do beats what not to do.
  const picked: Selection = { good: [], bad: [] };
  let chars = 0;
  for (const e of good) {
    if (picked.good.length >= maxGood) break;
    if (chars + e.transcript.length > maxChars) break;
    picked.good.push(e);
    chars += e.transcript.length;
  }
  for (const e of bad) {
    if (picked.bad.length >= maxBad) break;
    if (chars + e.transcript.length > maxChars) break;
    picked.bad.push(e);
    chars += e.transcript.length;
  }
  return picked;
}

/**
 * The prompt section.
 *
 * Returns "" when there is nothing to show, so a caller never has to special
 * case an empty corpus — and, today, so an empty corpus produces exactly the
 * prompt the system had before retrieval existed rather than a heading with
 * nothing under it.
 */
/** What the bot is currently able to draw on, for a screen to state plainly. */
export function retrievalSummary(corpus: CorpusExample[]): {
  usableGood: number; usableBad: number; unscrubbed: number; unapprovedGood: number;
} {
  const scrubbed = corpus.filter((e) => e.piiScrubbed);
  return {
    usableGood: scrubbed.filter((e) => e.conduct === "good" && e.approved).length,
    usableBad: scrubbed.filter((e) => e.conduct === "bad" || e.conduct === "mixed").length,
    unscrubbed: corpus.length - scrubbed.length,
    unapprovedGood: scrubbed.filter((e) => e.conduct === "good" && !e.approved).length,
  };
}

export function examplesPrompt(sel: Selection): string {
  const parts: string[] = [];

  if (sel.good.length) {
    parts.push(
      `HOW THIS HAS BEEN DONE WELL BEFORE\n` +
      `Real conversations a person reviewed and approved. Follow the shape of these.\n\n` +
      sel.good.map((e, i) =>
        `Good example ${i + 1}:\n${e.note ? `Why it is good: ${e.note}\n` : ""}${e.transcript}`
      ).join("\n\n")
    );
  }

  if (sel.bad.length) {
    parts.push(
      `MISTAKES THAT HAVE ALREADY BEEN MADE\n` +
      `Real conversations a person marked wrong, with the reason. Do NOT copy these — ` +
      `they are here so the same mistake is not made again.\n\n` +
      sel.bad.map((e, i) =>
        `Mistake ${i + 1}:\n${e.note ? `What went wrong: ${e.note}\n` : ""}${e.transcript}`
      ).join("\n\n")
    );
  }

  return parts.join("\n\n");
}
