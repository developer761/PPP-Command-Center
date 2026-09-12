/**
 * Repairing a conversation that nearly went right.
 *
 * All 34 of Kate's "mid" conversations carry an explicit correction — "asked
 * them to type the full address -> SHOULD HAVE: asked only for the missing
 * piece, by name" — so for each one we know what happened and what should have
 * happened. Rewriting that one line turns a near-miss into an example of the
 * thing done properly, and the corpus badly needs those: four of fifty-two are
 * good.
 *
 * WHY A PERSON PICKS THE LINE. Her findings are numbered against HER merged
 * transcript, which counts campaign emails and splits differently from how we
 * store one. T14 in her sheet lands on "Customer: I can speak tomorrow" in
 * ours, when the finding is about images three turns earlier. Indexing by her
 * number would have produced repairs that edit the wrong line and look
 * plausible, which is worse than not offering the feature.
 *
 * WHY A PERSON WRITES THE LINE. Her corrections are DESCRIPTIONS — "asked only
 * for the missing piece of the address, by name" is not something you can
 * send. Turning it into a message is judgement, and the whole point of this
 * corpus is to capture PPP's judgement rather than ours.
 *
 * Pure.
 */

export type TranscriptLine = { index: number; speaker: string; text: string };

/** Split a stored transcript into addressable lines. */
export function linesOf(transcript: string): TranscriptLine[] {
  return transcript.split("\n").map((raw, i) => {
    const m = /^([A-Za-z ()]+):\s*([\s\S]*)$/.exec(raw);
    return m
      ? { index: i, speaker: m[1].trim(), text: m[2].trim() }
      // A continuation line from a multi-line email body. Kept addressable so
      // the numbering stays honest, but it has no speaker of its own.
      : { index: i, speaker: "", text: raw.trim() };
  });
}

/** Only the bot's own lines can be repaired. */
export function isRepairable(line: TranscriptLine): boolean {
  const s = line.speaker.toLowerCase();
  return s === "emily" || s.startsWith("ai");
}

export type RepairResult =
  | { ok: true; transcript: string; changed: { from: string; to: string } }
  | { ok: false; error: string };

export function applyRepair(input: {
  transcript: string;
  lineIndex: number;
  replacement: string;
}): RepairResult {
  const lines = linesOf(input.transcript);
  const target = lines[input.lineIndex];
  if (!target) return { ok: false, error: "That line is not in this conversation." };
  if (!isRepairable(target)) {
    // Rewriting what the CUSTOMER said would be inventing a conversation
    // rather than repairing one, and the result would be indistinguishable
    // from a real transcript.
    return { ok: false, error: "Only what the bot said can be rewritten — not the customer." };
  }

  const next = input.replacement.trim();
  if (!next) return { ok: false, error: "Write what it should have said." };
  if (next === target.text.trim()) {
    return { ok: false, error: "That is what it already said, so nothing would change." };
  }

  const raw = input.transcript.split("\n");
  raw[input.lineIndex] = `${target.speaker}: ${next}`;
  return {
    ok: true,
    transcript: raw.join("\n"),
    changed: { from: target.text, to: next },
  };
}

/**
 * What to call the repair, so a reviewer can see at a glance what it claims.
 *
 * Names the RULE rather than the conversation, because that is what a reviewer
 * is being asked to agree with: does this line now demonstrate the thing it
 * was supposed to.
 */
export function repairNote(input: {
  what: string;
  shouldHave: string | null;
  from: string;
  to: string;
}): string {
  const parts = [`Repaired: ${input.what.trim()}`];
  if (input.shouldHave?.trim()) parts.push(`Should have ${input.shouldHave.trim()}.`);
  parts.push(`Was: "${input.from.trim()}" Now: "${input.to.trim()}"`);
  return parts.join(" ");
}
