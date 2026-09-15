/**
 * Repairing a conversation that nearly went right.
 *
 * Kate's "mid" conversations each carry what happened and what should have
 * happened. Rewriting the lines that were wrong turns a near-miss into an
 * example of the thing done properly, and the corpus badly needs those.
 *
 * TURNS NUMBER THE AI CONVERSATION, NOT THE CAMPAIGN. Kate, 2026-09-15: she
 * renumbered her sheet so T1 is the customer's first message, and asked that
 * the message the customer is replying to still be shown, unnumbered, as
 * "Previous Campaign Message". So Customer, Emily and Human agent messages
 * are turns, counted from 1 in the order sent; Campaign and Auto-reply
 * messages are shown in place with no number. Grading is about how the
 * conversation was handled, and nobody handled a campaign step.
 *
 * The stored transcripts carry the real order and speakers (rebuilt from her
 * sheet by kate-transcript.ts), which is what makes this reliable. A message
 * can span several stored lines, and those lines belong to the message above
 * them.
 *
 * History, because this changed twice in one day: the first import put the
 * customer first and called campaign messages Emily; the fix that morning
 * numbered campaign messages too, matching her sheet at the time; she then
 * moved her sheet to this, and so did this.
 *
 * SEVERAL LINES, ONE REPAIR. A conversation with two wrong lines repaired one
 * at a time became two "good" examples, each still carrying the other wrong
 * line. So a repair takes every fix at once, and an unsigned repair can be
 * reopened to add the one that was missed.
 *
 * WHY A PERSON WRITES THE LINE. Her corrections are descriptions: "asked only
 * for the missing piece of the address, by name" is not something you can
 * send. Turning one into a message is judgement, and the whole point of this
 * corpus is to capture PPP's judgement rather than ours.
 *
 * Pure.
 */

/** One message. */
export type Turn = {
  /** Kate's T-number. NULL for a campaign message or an auto-reply. */
  turn: number | null;
  /** Position among all messages, from 1. Stable key; never shown as a turn. */
  position: number;
  speaker: string;
  /** What to call it on screen: the speaker, or "Previous Campaign Message". */
  label: string;
  text: string;
  /** Stored line range, inclusive, so a repair replaces the whole message. */
  firstLine: number;
  lastLine: number;
};

// Only these start a message. Anything else with a colon, like
// "Availability:", is part of the message it sits in.
const SPEAKER = /^(Campaign|Customer|Emily|Human agent|Auto-reply|Agent|AI[^:]{0,20}|Bot):\s?([\s\S]*)$/i;

/** Messages that are context rather than part of the conversation handled. */
export function isUnnumbered(speaker: string): boolean {
  const s = speaker.toLowerCase();
  return s === "campaign" || s === "auto-reply";
}

/** The conversation as messages, numbered the way Kate numbers them. */
export function turnsOf(transcript: string): Turn[] {
  const turns: Turn[] = [];
  transcript.split("\n").forEach((line, i) => {
    const m = SPEAKER.exec(line);
    if (m) {
      const speaker = m[1].trim();
      turns.push({ turn: null, position: turns.length + 1, speaker, label: speaker, text: m[2], firstLine: i, lastLine: i });
      return;
    }
    const last = turns[turns.length - 1];
    if (last) {
      last.text += "\n" + line;
      last.lastLine = i;
    }
    // Text before any speaker belongs to nobody. It stays in the stored
    // transcript untouched and is simply not numbered.
  });

  let n = 0;
  turns.forEach((t, i) => {
    t.text = t.text.replace(/\s+$/, "");
    if (!isUnnumbered(t.speaker)) { t.turn = ++n; return; }
    // Kate: "include the message before the customer's reply even if it isn't
    // numbered, so I know which message the customer is replying to."
    const next = turns[i + 1];
    t.label = t.speaker.toLowerCase() === "campaign"
      ? next?.speaker.toLowerCase() === "customer" ? "Previous Campaign Message" : "Campaign Message"
      : "Auto-reply";
  });
  return turns;
}

/** Only the bot's own messages can be repaired. */
export function isRepairable(t: { speaker: string }): boolean {
  const s = t.speaker.toLowerCase();
  return s === "emily" || s.startsWith("ai") || s === "bot";
}

export type RepairFix = { turn: number; replacement: string };

export type RepairResult =
  | { ok: true; transcript: string; changed: { turn: number; from: string; to: string }[] }
  | { ok: false; error: string };

/**
 * Apply several fixes to one conversation at once.
 *
 * All or nothing. A repair that fixed T3 and quietly skipped T5 would be saved
 * as a good example while still containing a line somebody said was wrong,
 * which is exactly what it is meant to stop being.
 */
export function applyRepairs(input: { transcript: string; fixes: RepairFix[] }): RepairResult {
  if (input.fixes.length === 0) return { ok: false, error: "Pick at least one of Emily's lines to fix." };

  const turns = turnsOf(input.transcript);
  const seen = new Set<number>();
  const planned: { t: Turn; turn: number; to: string }[] = [];

  for (const f of input.fixes) {
    if (seen.has(f.turn)) return { ok: false, error: `T${f.turn} is fixed twice.` };
    seen.add(f.turn);
    const t = turns.find((x) => x.turn === f.turn);
    if (!t) return { ok: false, error: `There is no T${f.turn} in this conversation.` };
    if (!isRepairable(t)) {
      // Rewriting what the customer or a person said would be inventing a
      // conversation rather than repairing one, and the result would be
      // indistinguishable from a real transcript.
      return { ok: false, error: `T${f.turn} is ${t.speaker === "Customer" ? "the customer" : `a ${t.speaker.toLowerCase()} message`}. Only what Emily said can be rewritten.` };
    }
    const to = f.replacement.trim();
    if (!to) return { ok: false, error: `Write what T${f.turn} should have said.` };
    if (to === t.text.trim()) return { ok: false, error: `T${f.turn} already says that, so nothing would change.` };
    // A line inside the replacement that reads "Customer: ..." would become a
    // message of its own, invent something the customer never said, and move
    // every T-number after it.
    if (to.split("\n").some((l) => SPEAKER.test(l))) {
      return { ok: false, error: `T${f.turn} contains a line that starts like a new speaker. Write only what Emily says.` };
    }
    planned.push({ t, turn: f.turn, to });
  }

  // Bottom up, so replacing a multi-line message cannot shift the line
  // numbers of a message above it that is still to be replaced.
  const raw = input.transcript.split("\n");
  for (const { t, to } of [...planned].sort((a, b) => b.t.firstLine - a.t.firstLine)) {
    raw.splice(t.firstLine, t.lastLine - t.firstLine + 1, `${t.speaker}: ${to}`);
  }

  return {
    ok: true,
    transcript: raw.join("\n"),
    changed: planned
      .sort((a, b) => a.turn - b.turn)
      .map(({ t, turn, to }) => ({ turn, from: t.text.trim(), to })),
  };
}

/**
 * Which turns differ between a conversation and its repair.
 *
 * For repairs saved before fixes were stored per turn: the transcript is the
 * only record of what changed, and a repair has the same messages as its
 * original, so message N lines up with message N. Only numbered turns can have
 * been repaired, so an unnumbered difference is not reported as a fix.
 */
export function changedTurns(original: string, repaired: string): { turn: number; from: string; to: string }[] {
  const a = turnsOf(original);
  const b = turnsOf(repaired);
  if (a.length !== b.length) return [];
  return a
    .map((t, i) => ({ turn: t.turn, from: t.text.trim(), to: b[i].text.trim() }))
    .filter((d): d is { turn: number; from: string; to: string } => d.turn !== null && d.from !== d.to);
}

/**
 * What the repair claims, one line per fixed turn, so a reviewer can see what
 * they are being asked to agree with.
 */
export function repairNote(
  fixes: { turn: number; what: string; codes?: string[]; from: string; to: string }[]
): string {
  return fixes
    .map((f) => {
      const codes = f.codes?.length ? ` [${f.codes.join(", ")}]` : "";
      return `T${f.turn}${codes}: ${f.what.trim()} Was: "${f.from.trim()}" Now: "${f.to.trim()}"`;
    })
    .join("\n");
}
