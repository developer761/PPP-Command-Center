import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { getCommercialSetting, setCommercialSetting } from "@/lib/commercial/settings";
import type { ReceivablesReport, ReceivableRow } from "./receivables";

/**
 * A drafted note for the rows nobody has written one for.
 *
 * Karan, 2026-08-19: *"if theres no notes then we should have AI notes for them
 * to the best of our ability looking at all the information were provided from
 * that opp like due dates, and everything else."*
 *
 * The reason this is worth doing: Mary's column is the most valuable thing on
 * the receivables sheet and the emptiest. A row that reads "$3,135.00 · no
 * note" tells Alex nothing he can act on, and the facts that WOULD tell him
 * something — when it went out, what the terms are, whether it's the GC's only
 * open item, whether it's even chaseable yet — are all sitting on the same row,
 * unread.
 *
 * Four rules it is built to:
 *
 *  1. **A human note always wins.** These fill silence; they never overwrite,
 *     and they never pre-fill the input box, because a draft sitting in a text
 *     field becomes a human note the moment somebody hits Save.
 *
 *  2. **Marked, subtly.** Alex has to be able to tell what Mary knows from
 *     what a model inferred — one is a phone call, the other is arithmetic. A
 *     small "✦" and a legend, not a banner.
 *
 *  3. **ONE call for the whole book**, cached against the figures it was
 *     written from. Fifteen rows is not fifteen API calls.
 *
 *  4. **No invention.** The prompt gets facts and is told to say nothing that
 *     isn't in them. "Sent 8/18, 30-day terms — not chaseable until 9/17" is
 *     useful. "The GC is probably waiting on the owner" is a liability.
 */

const CACHE_KEY = "commercial_receivable_row_notes";
const MODEL = "claude-opus-5";

/** The glyph that marks a drafted note wherever one is shown. */
export const AI_NOTE_MARK = "✦";

export type RowNoteCache = {
  /** rowKey → the drafted note. */
  notes: Record<string, string>;
  inputHash: string;
  generatedAt: string;
};

/** The rows a note would be written for: no human note, and money on them. */
export function rowsNeedingNotes(report: ReceivablesReport): ReceivableRow[] {
  return report.rows.filter((r) => !r.note?.trim());
}

/** What the notes were written from. Changing facts ⇒ new hash ⇒ stale. */
function hashInput(rows: ReceivableRow[]): string {
  const shape = rows
    .map((r) => `${r.key}:${r.openCents}:${r.daysOut ?? ""}:${r.issuedIso ?? ""}`)
    .sort()
    .join("|");
  return createHash("sha256").update(shape).digest("hex").slice(0, 16);
}

export function rowNotesAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export async function getCachedRowNotes(
  report: ReceivablesReport
): Promise<{ notes: Record<string, string>; stale: boolean; generatedAt: string | null }> {
  const cached = await getCommercialSetting<RowNoteCache | null>(CACHE_KEY, null).catch(() => null);
  const need = rowsNeedingNotes(report);
  if (!cached?.notes) return { notes: {}, stale: need.length > 0, generatedAt: null };
  return {
    notes: cached.notes,
    stale: cached.inputHash !== hashInput(need),
    generatedAt: cached.generatedAt,
  };
}

/**
 * Facts for one row, in the words the model is allowed to reason from.
 *
 * Deliberately narrow. No contact names, no addresses, no note history — a
 * chase note needs the money, the dates and the shape of the book, and every
 * extra field is another thing that can end up quoted in an email to a GC.
 */
function factsFor(r: ReceivableRow, report: ReceivablesReport): string {
  const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  const sameGc = report.rows.filter((x) => x.accountId === r.accountId);
  const gcTotal = sameGc.reduce((n, x) => n + x.openCents, 0);
  const bits = [
    `job: ${r.jobName}`,
    `gc: ${r.accountName}`,
    `type: ${r.kind === "aia" ? "AIA payment application" : r.kind === "retainage" ? "retainage held" : "invoice"}`,
    `amount: ${money(r.openCents)}`,
    `reference: ${r.reference || "none"}`,
    r.kind === "retainage"
      ? "due: not payable until close-out"
      : r.daysOut === null
        ? "due: NO DUE DATE RECORDED"
        : r.daysOut > 0
          ? `due: ${r.daysOut} days past due`
          : `due: not yet due (${Math.abs(r.daysOut)} days to go)`,
    sameGc.length > 1
      ? `this gc: ${sameGc.length} open items totalling ${money(gcTotal)}`
      : `this gc: this is their only open item`,
    `share of the book: ${report.totalOpenCents > 0 ? Math.round((r.openCents / report.totalOpenCents) * 100) : 0}%`,
  ];
  return `${r.key} — ${bits.join("; ")}`;
}

/**
 * Draft notes for every row that hasn't got one. Returns the previous cache on
 * failure — a report that loses its notes is worse than notes a few hours old.
 */
export async function generateRowNotes(
  report: ReceivablesReport
): Promise<{ ok: true; notes: Record<string, string> } | { ok: false; error: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: "No Anthropic API key is configured on this environment." };
  const need = rowsNeedingNotes(report);
  if (need.length === 0) {
    return { ok: false, error: "Every open item already has a note — nothing to draft." };
  }

  const prompt = `You are drafting the "notes" column on a commercial painting contractor's receivables sheet. A person (Mary) normally writes these after a phone call — "8/19 asked for update", "s/b paid within 2 weeks". You are filling in the rows nobody has written one for yet, using only the facts given.

One line per row, in this exact format, nothing else:

<row key> :: <note>

Rows:
${need.map((r) => factsFor(r, report)).join("\n")}

Rules — these matter more than being interesting:
- Use ONLY the facts on that row. Never guess why a GC hasn't paid, never invent a conversation, a person, or a promise.
- Say what the state IS and what the next step would be. "Sent 8/18 on 30-day terms — nothing to chase until 9/17" beats "Follow up with the customer".
- Retainage is NOT late and must never be described as owed now or chased. It is released at close-out.
- An item with NO DUE DATE RECORDED: say that plainly and that setting one is what makes it chaseable.
- If an item is a large share of the book, or the GC's only open item, that is worth saying once — not on every row.
- Max 14 words. No trailing full stop. No quotes around the note. Plain sentence case.
- Every row key you were given must appear exactly once.`;

  try {
    const client = new Anthropic({ apiKey });
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1200,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const wanted = new Set(need.map((r) => r.key));
    const notes: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const idx = line.indexOf("::");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const note = line.slice(idx + 2).trim().replace(/^["']|["'.]$/g, "").trim();
      // Only keys we asked about. A model that invents a row must not be able
      // to put a note against a receivable that doesn't exist.
      if (!wanted.has(key) || !note) continue;
      notes[key] = note.slice(0, 200);
    }
    if (Object.keys(notes).length === 0) {
      return { ok: false, error: "Couldn't read the drafted notes. Try again." };
    }

    const payload: RowNoteCache = {
      notes,
      inputHash: hashInput(need),
      generatedAt: new Date().toISOString(),
    };
    await setCommercialSetting(CACHE_KEY, payload, null).catch(() => undefined);
    return { ok: true, notes };
  } catch (err) {
    console.error("[receivable-row-notes] generate failed:", err);
    return { ok: false, error: "Couldn't draft the notes just now. The sheet is unaffected." };
  }
}

/**
 * Merge drafted notes onto a report.
 *
 * Never touches a row that already has a human note — that is the whole
 * contract, and it lives here so no caller can get it wrong.
 */
export function withDraftedNotes(
  report: ReceivablesReport,
  notes: Record<string, string>
): ReceivablesReport {
  return {
    ...report,
    rows: report.rows.map((r) =>
      r.note?.trim() ? r : { ...r, aiNote: notes[r.key] ?? null }
    ),
  };
}
