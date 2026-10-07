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
  /** Where it came from. 'simulated' is a sandbox run somebody exported. */
  source?: string | null;
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

/**
 * HOW MUCH EACH TAG IS WORTH, not merely whether it is wanted.
 *
 * Relevance used to be a COUNT of matching tags, so every reason to want an
 * example weighed the same. A customer sends a photo, the photo example scores
 * 1 for `handled_photo`, and every ordinary flow example also scores 1 for
 * `flow_details` — a tie, broken by id, with three good slots and a corpus of
 * 1,294. The photo example never appeared. Detecting the situation changed
 * nothing at all, which is why nobody could see it was broken.
 *
 * So the ranking says what is actually true of a turn:
 *
 *   3  the situation the customer is in RIGHT NOW — they sent a photo, asked
 *      if we are a bot, asked to be called. Specific, rare, and the hardest
 *      thing for the model to get right unaided.
 *   2  the step of the flow we are on. Always true of something, so it cannot
 *      be allowed to outrank the first.
 *   1  the rules that bind every message. Never a reason to prefer one
 *      example over another, only a reason not to pick something irrelevant.
 */
const SITUATIONAL_WEIGHT = 3;
const STAGE_WEIGHT = 2;
const ALWAYS_WEIGHT = 1;

export function relevantTagWeights(ctx: RetrievalContext): Map<string, number> {
  const out = new Map<string, number>();
  // Highest claim wins: a tag wanted for two reasons is worth the better one.
  const put = (t: string, n: number) => out.set(t, Math.max(out.get(t) ?? 0, n));
  for (const t of ALWAYS) put(t, ALWAYS_WEIGHT);
  if (ctx.track !== "nurture") {
    for (const t of STAGE_TAGS[Math.min(ctx.stage ?? 0, STAGE_TAGS.length - 1)]) put(t, STAGE_WEIGHT);
  }
  for (const rule of SITUATIONAL) {
    if (rule.when(ctx)) for (const t of rule.tags) put(t, SITUATIONAL_WEIGHT);
  }
  return out;
}

export function relevantTags(ctx: RetrievalContext): string[] {
  return [...relevantTagWeights(ctx).keys()];
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
  const wanted = relevantTagWeights(ctx);

  // Never anything unscrubbed, whatever else is true of it.
  const safe = corpus.filter((e) => e.piiScrubbed && e.transcript.trim());

  // Weighted, not counted. See relevantTagWeights: counting made "they just
  // sent a photo" worth exactly as much as "we are on step one", which every
  // example in the corpus can claim.
  const score = (e: CorpusExample) => e.tags.reduce((n, t) => n + (wanted.get(t) ?? 0), 0);
  // A REAL conversation outranks a simulated one at equal relevance.
  //
  // Migration 195's worry was that training on invented customers teaches the
  // bot to handle an imagination. Exported sandbox runs are allowed here —
  // somebody read them and decided — but they sorted identically to real ones,
  // so a corpus with a handful of exports could crowd out actual customer
  // conversations. Real first, always.
  const isReal = (e: CorpusExample) => e.source !== "simulated";
  // Most relevant first; among equals, the ones carrying a written reason,
  // because a reason is what makes an example teach rather than decorate.
  const rank = (a: CorpusExample, b: CorpusExample) =>
    score(b) - score(a)
    || Number(isReal(b)) - Number(isReal(a))
    || Number(!!b.note) - Number(!!a.note)
    || a.id.localeCompare(b.id);

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

/**
 * A REPAIR'S NOTE IS NOT A REASON IT IS GOOD.
 *
 * Found 2026-10-06 by printing the prompt the bot actually receives, which
 * opened:
 *
 *   Good example 1:
 *   Why it is good: T2: Asked for the full address including the zip code
 *   while already holding 07920. It made the customer retype what we had...
 *
 * That is a DEFECT, rendered under a heading saying it is why the example is
 * good. The data is fine — `derived` examples are repairs, and repairNote
 * writes "what was wrong … Was: … Now: …", which is exactly what a repair
 * record should say. The heading was putting the wrong frame on it, and the
 * sentence a reader meets first is the fault rather than the fix.
 *
 * It matters most for the rule it keeps landing on: of the twelve good
 * examples carrying a note, eight are repairs, and several describe asking for
 * an address we already held — A11, the most breached rule in the corpus. The
 * one lesson being reinforced under a "good" heading was the commonest mistake
 * in the whole dataset.
 *
 * Approval is NOT the issue and was checked: both the main filter and the
 * top-up require `approved`, so an unread repair never reaches the model.
 */
function noteHeading(e: CorpusExample): string {
  return e.source === "derived"
    ? "This is a CORRECTED version — what was wrong before, and what it now says"
    : "Why it is good";
}

export function examplesPrompt(sel: Selection): string {
  const parts: string[] = [];

  if (sel.good.length) {
    parts.push(
      `HOW THIS HAS BEEN DONE WELL BEFORE\n` +
      `Real conversations a person reviewed and approved. Follow the shape of these.\n\n` +
      sel.good.map((e, i) =>
        `Good example ${i + 1}:\n${e.note ? `${noteHeading(e)}: ${e.note}\n` : ""}${e.transcript}`
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
