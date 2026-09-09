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
  /** …and the reaction was a negative one. */
  isNegative?: boolean;
  /** They asked whether they are talking to a machine. */
  asksIfBot?: boolean;
  /** They asked to be phoned. */
  asksForCall?: boolean;
  /** They asked whether we cover their area. */
  mentionsArea?: boolean;
  /** They want a number rather than a visit. */
  wantsQuoteOnly?: boolean;
  track?: Track;
};

/** Rules that matter at each step of the flow. */
const STAGE_TAGS: string[][] = [
  ["flow_details", "flow_order"],
  ["flow_address", "flow_order"],
  ["flow_contact", "flow_order"],
  ["flow_availability", "flow_order"],
];

/**
 * Rules that are live in every single turn.
 *
 * Broader than it first looks, and deliberately: how a reply sounds, how short
 * an acknowledgement is, and never inventing a time all apply to every message
 * regardless of what the customer just sent.
 */
const ALWAYS = [
  "price_refused", "scope_refused", "one_question", "no_echo",
  "natural_voice", "brief_ack", "no_invented_time", "ended_correctly",
];

/** Situations we can actually detect from the message in front of us. */
const SITUATIONAL: { when: (ctx: RetrievalContext) => boolean; tags: string[] }[] = [
  { when: (c) => (c.mediaCount ?? 0) > 0, tags: ["handled_photo"] },
  { when: (c) => !!c.isReaction, tags: ["handled_reaction"] },
  { when: (c) => !!c.isNegative, tags: ["handled_negative", "handled_reaction"] },
  { when: (c) => !!c.asksIfBot, tags: ["handled_bot_q"] },
  { when: (c) => !!c.asksForCall, tags: ["handled_callback"] },
  { when: (c) => !!c.mentionsArea, tags: ["area_checked"] },
  { when: (c) => !!c.wantsQuoteOnly, tags: ["offsite_required", "offsite_suggested", "offsite_still_collected"] },
];

export function relevantTags(ctx: RetrievalContext): string[] {
  const out = new Set<string>(ALWAYS);
  if (ctx.track !== "nurture") {
    for (const t of STAGE_TAGS[Math.min(ctx.stage ?? 0, STAGE_TAGS.length - 1)]) out.add(t);
  }
  for (const rule of SITUATIONAL) {
    if (rule.when(ctx)) for (const t of rule.tags) out.add(t);
  }
  return [...out];
}

/**
 * Read the situation out of what the customer sent.
 *
 * Kept here rather than at the call site so every caller detects the same
 * things the same way. Deliberately coarse — this only decides which examples
 * are OFFERED, so a false positive costs one slot and a false negative costs
 * an example the model might have benefited from.
 */
export function situationFrom(text: string, opts: {
  mediaCount?: number; isReaction?: boolean; isNegative?: boolean;
} = {}): Partial<RetrievalContext> {
  const t = (text ?? "").toLowerCase();
  return {
    mediaCount: opts.mediaCount,
    isReaction: opts.isReaction,
    isNegative: opts.isNegative,
    asksIfBot: /\b(a |an )?(bot|robot|ai|real person|human|automated)\b/.test(t),
    asksForCall: /\b(call me|give me a call|phone me|ring me|call back|speak to someone)\b/.test(t),
    mentionsArea: /\b(do you (cover|serve|service|come out)|are you in|service area|too far)\b/.test(t),
    wantsQuoteOnly: /\b(ball ?park|rough (price|idea|estimate)|just (a|the) price|how much|over the phone|by text|quote by)\b/.test(t),
  };
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

  // A LAST RESORT, and the reason it exists is worth stating.
  //
  // Relevance is scored on tags, so an example whose tags never come up in any
  // situation we can detect was invisible for ever: graded, counted as covered
  // on the training page, and never once shown to the model. Thirteen of the
  // twenty-five tags were in that state — including every awkward-situation
  // one, which is exactly the material Kate is being asked for.
  //
  // Detecting more situations shrinks the problem; it cannot close it, because
  // some rules have no signal in the customer's message at all. So when there
  // is spare budget, it goes to the best of the rest rather than to nothing.
  const topUp = (pool: CorpusExample[], already: CorpusExample[]) =>
    safe.filter((e) => !pool.includes(e) && !already.includes(e));

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

  // Spare slots go to examples that matched nothing, newest safety rules still
  // applying: approved and good to imitate, graded bad to avoid.
  if (picked.good.length < maxGood) {
    for (const e of topUp(good, picked.good).filter((e) => e.conduct === "good" && e.approved).sort(rank)) {
      if (picked.good.length >= maxGood) break;
      if (chars + e.transcript.length > maxChars) break;
      picked.good.push(e);
      chars += e.transcript.length;
    }
  }
  if (picked.bad.length < maxBad) {
    for (const e of topUp(bad, picked.bad).filter((e) => e.conduct === "bad" || e.conduct === "mixed").sort(rank)) {
      if (picked.bad.length >= maxBad) break;
      if (chars + e.transcript.length > maxChars) break;
      picked.bad.push(e);
      chars += e.transcript.length;
    }
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
