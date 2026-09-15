/**
 * Repairing a conversation that nearly went right.
 *
 * Kate's "mid" conversations each carry what happened and what should have
 * happened. Rewriting the lines that were wrong turns a near-miss into an
 * example of the thing done properly, and the corpus badly needs those.
 *
 * TURNS ARE NUMBERED KATE'S WAY. One message is one turn, counted from 1, and
 * the customer's first message is T1. A message can span several stored lines
 * (a form submission carries blank lines and an "Availability:" block under
 * it), and those lines belong to the message above them rather than being
 * turns of their own. Checked against her own repair of 2026-09-15: the full
 * address ask she calls T3 and the street ask she calls T5 are the third and
 * fifth messages here. An earlier version of this file said her numbers could
 * not be trusted. That was about a PDF export that merged in campaign emails,
 * and it is not true of the transcripts stored now.
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

/** One message. `turn` is Kate's T-number. */
export type Turn = {
  turn: number;
  speaker: string;
  text: string;
  /** Stored line range, inclusive, so a repair replaces the whole message. */
  firstLine: number;
  lastLine: number;
};

// Only these start a message. Anything else with a colon, like
// "Availability:", is part of the message it sits in.
const SPEAKER = /^(Customer|Emily|Human agent|Agent|AI[^:]{0,20}|Bot):\s?([\s\S]*)$/i;

/** The conversation as messages, numbered the way Kate numbers them. */
export function turnsOf(transcript: string): Turn[] {
  const turns: Turn[] = [];
  transcript.split("\n").forEach((line, i) => {
    const m = SPEAKER.exec(line);
    if (m) {
      turns.push({ turn: turns.length + 1, speaker: m[1].trim(), text: m[2], firstLine: i, lastLine: i });
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
  for (const t of turns) t.text = t.text.replace(/\s+$/, "");
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
  const planned: { t: Turn; to: string }[] = [];

  for (const f of input.fixes) {
    if (seen.has(f.turn)) return { ok: false, error: `T${f.turn} is fixed twice.` };
    seen.add(f.turn);
    const t = turns.find((x) => x.turn === f.turn);
    if (!t) return { ok: false, error: `There is no T${f.turn} in this conversation.` };
    if (!isRepairable(t)) {
      // Rewriting what the CUSTOMER said would be inventing a conversation
      // rather than repairing one, and the result would be indistinguishable
      // from a real transcript.
      return { ok: false, error: `T${f.turn} is the customer. Only what Emily said can be rewritten.` };
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
    planned.push({ t, to });
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
      .sort((a, b) => a.t.turn - b.t.turn)
      .map(({ t, to }) => ({ turn: t.turn, from: t.text.trim(), to })),
  };
}

/**
 * Which turns differ between a conversation and its repair.
 *
 * For repairs saved before fixes were stored per turn: the transcript is the
 * only record of what changed, and a repair has the same number of messages as
 * its original, so turn N lines up with turn N.
 */
export function changedTurns(original: string, repaired: string): { turn: number; from: string; to: string }[] {
  const a = turnsOf(original);
  const b = turnsOf(repaired);
  if (a.length !== b.length) return [];
  return a
    .map((t, i) => ({ turn: t.turn, from: t.text.trim(), to: b[i].text.trim() }))
    .filter((d) => d.from !== d.to);
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
