/**
 * What did the customer actually send?
 *
 * Named in the 2026-09-02 meeting as a significant frustration with Hatch: it
 * cannot read emoji, message reactions, or photos. A customer thumbs-ups a
 * question and Hatch sees gibberish, so the conversation derails.
 *
 * Reactions arrive over SMS as TEXT, and the format differs by platform:
 *
 *   iPhone   Liked "Would around 12 or 2 work?"
 *            Loved / Laughed at / Emphasized / Questioned / Disliked
 *   Android  👍 to "Would around 12 or 2 work?"
 *   RCS      the bare emoji
 *
 * The important part is not detecting them. It is that a reaction MEANS
 * something different depending on what it is reacting to, and Emily's prompt
 * already says so:
 *
 *   last bot message was informational  -> a reaction is confirmation.
 *                                          Reply "Got it." and end.
 *   last bot message asked a QUESTION   -> a reaction is NOT an answer.
 *                                          Rephrase. Do NOT say "Got it".
 *
 * That second case is the bug. Treating a thumbs-up on "what's your address?"
 * as an answer loses the address and moves the flow on without it.
 */

export type InboundKind = "text" | "reaction" | "emoji_only" | "media" | "empty";

export type ReactionSentiment = "positive" | "negative" | "questioning" | "neutral";

export type NormalizedInbound = {
  kind: InboundKind;
  /** What the model should be shown, in words. Never raw platform syntax. */
  description: string;
  /** The original, untouched. Reactions are evidence and get stored verbatim. */
  raw: string;
  /** Ordinary text with reaction wrapping removed, when there is any. */
  text: string | null;
  reaction?: { verb: string; sentiment: ReactionSentiment; target: string | null };
  mediaCount?: number;
};

/** iPhone reaction verbs, and what each one means for the flow. */
const IPHONE_VERBS: { re: RegExp; verb: string; sentiment: ReactionSentiment }[] = [
  { re: /^liked\s+/i,        verb: "liked",        sentiment: "positive" },
  { re: /^loved\s+/i,        verb: "loved",        sentiment: "positive" },
  { re: /^laughed at\s+/i,   verb: "laughed at",   sentiment: "neutral" },
  { re: /^emphasi[sz]ed\s+/i, verb: "emphasised",  sentiment: "positive" },
  { re: /^questioned\s+/i,   verb: "questioned",   sentiment: "questioning" },
  { re: /^disliked\s+/i,     verb: "disliked",     sentiment: "negative" },
  { re: /^removed a (?:like|heart|reaction) from\s+/i, verb: "removed a reaction from", sentiment: "neutral" },
];

/** Emoji that carry a clear meaning when sent alone. */
const EMOJI_SENTIMENT: { chars: string[]; sentiment: ReactionSentiment; word: string }[] = [
  { chars: ["👍", "👌", "🙌", "✅", "☑️", "🆗"], sentiment: "positive", word: "thumbs up" },
  { chars: ["❤️", "♥️", "😍", "🥰", "💯"], sentiment: "positive", word: "a heart" },
  { chars: ["😂", "🤣", "😄", "😊", "🙂"], sentiment: "positive", word: "a smile" },
  // Split, because these do not mean the same thing and the model is being
  // told what the customer actually sent. An angry face reported as "thumbs
  // down" is a false statement about the conversation, and anger and mild
  // irritation call for different replies.
  { chars: ["👎"], sentiment: "negative", word: "thumbs down" },
  { chars: ["😡", "🤬", "😠"], sentiment: "negative", word: "an angry face" },
  { chars: ["🙄", "😤"], sentiment: "negative", word: "an exasperated face" },
  { chars: ["❓", "❔", "🤔"], sentiment: "questioning", word: "a question mark" },
];

// Anything in the emoji planes, plus the variation selector and ZWJ that
// compose them. Used to decide whether a message is emoji ONLY.
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{20E3}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;

/**
 * Normalise one inbound message.
 *
 * `mediaCount` comes from the carrier payload, not the body — an MMS with a
 * photo and no text is not an empty message, and treating it as one loses the
 * photo the customer was asked for.
 */
export function normalizeInbound(raw: string, mediaCount = 0): NormalizedInbound {
  const body = (raw ?? "").trim();

  // iPhone-style: verb followed by the quoted message it reacted to.
  for (const { re, verb, sentiment } of IPHONE_VERBS) {
    if (!re.test(body)) continue;
    const rest = body.replace(re, "");
    // The quotes matter. "Liked the color you picked" is a sentence, not a
    // reaction — without requiring the quoted target we would swallow it and
    // reply "Got it." to a customer who was talking to us.
    const quoted = /^[“"']([\s\S]*)[”"']$/.exec(rest.trim());
    if (!quoted) continue;
    return {
      kind: "reaction",
      description: `The customer ${verb} the message: "${truncate(quoted[1])}"`,
      raw, text: null,
      reaction: { verb, sentiment, target: quoted[1] },
    };
  }

  // Android-style: emoji, then "to", then the quoted message.
  const android = /^(\p{Extended_Pictographic}[\p{Extended_Pictographic}\u{FE0F}\u{200D}]*)\s+to\s+[“"']([\s\S]*)[”"']$/u.exec(body);
  if (android) {
    const s = sentimentOf(android[1]);
    return {
      kind: "reaction",
      description: `The customer reacted with ${s.word} to the message: "${truncate(android[2])}"`,
      raw, text: null,
      reaction: { verb: `reacted with ${s.word}`, sentiment: s.sentiment, target: android[2] },
    };
  }

  const hasText = body.replace(EMOJI_RE, "").trim().length > 0;

  if (!body && mediaCount > 0) {
    return {
      kind: "media",
      description: `The customer sent ${mediaCount} photo${mediaCount === 1 ? "" : "s"} with no message.`,
      raw, text: null, mediaCount,
    };
  }
  if (mediaCount > 0) {
    return {
      kind: "media",
      description: `The customer sent ${mediaCount} photo${mediaCount === 1 ? "" : "s"} and wrote: ${body}`,
      raw, text: body, mediaCount,
    };
  }
  if (!body) {
    return { kind: "empty", description: "The customer sent an empty message.", raw, text: null };
  }

  // Emoji with no words. Carries meaning, but it is not an answer to a
  // question — same rule as a reaction.
  if (!hasText) {
    const s = sentimentOf(body);
    return {
      kind: "emoji_only",
      description: `The customer replied with ${s.word} and no words.`,
      raw, text: null,
      reaction: { verb: `sent ${s.word}`, sentiment: s.sentiment, target: null },
    };
  }

  return { kind: "text", description: body, raw, text: body };
}

/**
 * Emily's rule, made explicit.
 *
 * A reaction confirms an informational message and does NOT answer a question.
 * The caller knows whether the last outbound asked for something; this decides
 * what that means.
 */
export function reactionResponse(
  inbound: NormalizedInbound,
  lastOutboundAskedForInfo: boolean
): { treatAs: "confirmation" | "not_an_answer" | "normal"; guidance: string } {
  if (inbound.kind !== "reaction" && inbound.kind !== "emoji_only") {
    return { treatAs: "normal", guidance: "" };
  }

  // A negative reaction is never a confirmation, whatever it is reacting to.
  // Reading a thumbs-down on "checking our schedule" as agreement is worse
  // than reading it as nothing.
  if (inbound.reaction?.sentiment === "negative") {
    return {
      treatAs: "not_an_answer",
      guidance: "The customer reacted negatively. Do not treat this as agreement. Acknowledge and ask what they would prefer.",
    };
  }

  if (lastOutboundAskedForInfo) {
    return {
      treatAs: "not_an_answer",
      guidance: 'The last message asked the customer to provide something, and a reaction does not answer it. Rephrase the question. Do not say "Got it".',
    };
  }

  return {
    treatAs: "confirmation",
    guidance: 'The last message was informational, so the reaction confirms it. Reply "Got it." and end as Msg Liked/Loved.',
  };
}

function sentimentOf(s: string): { sentiment: ReactionSentiment; word: string } {
  for (const e of EMOJI_SENTIMENT) {
    if (e.chars.some((c) => s.includes(c))) return { sentiment: e.sentiment, word: e.word };
  }
  return { sentiment: "neutral", word: "an emoji" };
}

function truncate(s: string, n = 60): string {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}
