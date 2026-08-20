import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { getCommercialSetting, setCommercialSetting } from "@/lib/commercial/settings";
import type { ReceivablesReport, ReceivableRow } from "./receivables";
import { modelErrorReason } from "./receivables-brief";

/**
 * THE AI READ — a second column beside Mary's, never inside it.
 *
 * Karan, 2026-08-19: *"we should have a separate section for drafted AI notes
 * so alex can differentiate between mary and AI notes just in case. Also the AI
 * notes should be adaptive — if mary has notes AI should basically reword the
 * sentence; if AI written notes and mary wrote notes after, AI should check and
 * either keep the same or rewrite."*
 *
 * That is a different design from filling in blanks, and a better one:
 *
 *  · **Every row gets a read**, not just the silent ones. Where Mary has
 *    written something, the read CARRIES IT FORWARD — what her note means for
 *    the money and what happens next. "Change order billing" is a fact; "CO
 *    billing, sent 8/18, nothing to chase until 9/17" is the same fact made
 *    actionable, and it's the version Alex can act on at 6am.
 *
 *  · **Separate column, never merged.** One is a phone call, the other is
 *    arithmetic, and Alex has to be able to tell instantly which is which.
 *    Mary's column is hers; this one is labelled and marked wherever it shows.
 *
 *  · **Per-ROW staleness, not per-book.** Each row is hashed against its own
 *    facts INCLUDING Mary's note, so when she writes on a row after a draft
 *    exists, only that row is reconsidered — it gets rewritten if her note
 *    changed the picture and left alone if it didn't. Hashing the whole book
 *    couldn't tell which row moved, so it would redraw all of them or none.
 *
 *  · **No invention.** The model gets facts and Mary's own words, and is told
 *    to stay inside them. It may never contradict her.
 */

const CACHE_KEY = "commercial_receivable_row_notes";
const MODEL = "claude-opus-5";

/** The glyph that marks the AI column wherever it appears. */
export const AI_NOTE_MARK = "✦";

/** One drafted read, and the row facts it was written from. */
export type RowNoteEntry = { note: string; hash: string; at: string };
export type RowNoteCache = { notes: Record<string, RowNoteEntry> };

/**
 * The facts a read is written from, as one string.
 *
 * Mary's note is IN here on purpose: it is what makes the read adaptive. Change
 * her note and this row's hash changes, so the read is reconsidered — which is
 * the whole "she wrote after, check and keep or rewrite" behaviour, falling out
 * of the hash rather than needing a rule.
 */
function rowFacts(r: ReceivableRow, report: ReceivablesReport): string {
  const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  const sameGc = report.rows.filter((x) => x.accountId === r.accountId);
  const gcTotal = sameGc.reduce((n, x) => n + x.openCents, 0);
  return [
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
      : "this gc: this is their only open item",
    `share of the book: ${report.totalOpenCents > 0 ? Math.round((r.openCents / report.totalOpenCents) * 100) : 0}%`,
    r.note?.trim() ? `note from the office: "${r.note.trim()}"` : "note from the office: none",
  ].join("; ");
}

function hashFacts(facts: string): string {
  return createHash("sha256").update(facts).digest("hex").slice(0, 16);
}

/** The hash a row's read is stored against. Exported so a test can build a
 *  legitimate "already current" cache instead of reverse-engineering one. */
export function rowFactHash(r: ReceivableRow, report: ReceivablesReport): string {
  return hashFacts(rowFacts(r, report));
}

/** Tolerates the older cache shape (a plain string per row) by treating it as
 *  hash-less — which makes it stale, so it is rewritten once and forgotten. */
function readCache(raw: unknown): Record<string, RowNoteEntry> {
  const notes = (raw as RowNoteCache | null)?.notes;
  if (!notes || typeof notes !== "object") return {};
  const out: Record<string, RowNoteEntry> = {};
  for (const [k, v] of Object.entries(notes)) {
    if (typeof v === "string") out[k] = { note: v, hash: "", at: "" };
    else if (v && typeof v === "object" && typeof (v as RowNoteEntry).note === "string") {
      out[k] = v as RowNoteEntry;
    }
  }
  return out;
}

export function rowNotesAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/** Rows whose read is missing, or written from facts that have since moved. */
export function staleRows(
  report: ReceivablesReport,
  cache: Record<string, RowNoteEntry>
): ReceivableRow[] {
  return report.rows.filter((r) => cache[r.key]?.hash !== hashFacts(rowFacts(r, report)));
}

export async function getCachedRowNotes(report: ReceivablesReport): Promise<{
  notes: Record<string, string>;
  staleCount: number;
  generatedAt: string | null;
}> {
  const cache = readCache(await getCommercialSetting<RowNoteCache | null>(CACHE_KEY, null).catch(() => null));
  const notes: Record<string, string> = {};
  let newest: string | null = null;
  for (const [k, v] of Object.entries(cache)) {
    notes[k] = v.note;
    if (v.at && (!newest || v.at > newest)) newest = v.at;
  }
  return { notes, staleCount: staleRows(report, cache).length, generatedAt: newest };
}

/**
 * Draft or redraft the reads that need it — and ONLY those.
 *
 * A row whose facts haven't moved keeps the exact words it had. That is not
 * only cheaper: a report whose wording churns every morning for no reason is
 * one people stop reading closely.
 */
export async function generateRowNotes(
  report: ReceivablesReport
): Promise<{ ok: true; notes: Record<string, string>; wrote: number } | { ok: false; error: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: "No Anthropic API key is configured on this environment." };

  const cache = readCache(await getCommercialSetting<RowNoteCache | null>(CACHE_KEY, null).catch(() => null));
  const need = staleRows(report, cache);
  if (need.length === 0) {
    return { ok: false, error: "Every open item already has a current read — nothing to redraft." };
  }

  const prompt = `You are writing the "AI read" column on a commercial painting contractor's receivables sheet. The CEO reads it on his phone at 6am. Beside your column is the office's own notes column, written by a person after phone calls — "8/19 asked for update", "s/b paid within 2 weeks".

Your column never replaces theirs. It sits next to it and says what the row MEANS: where it stands and what happens next.

One line per row, in this exact format, nothing else:

<row key> :: <read>

Rows:
${need.map((r) => `${r.key} — ${rowFacts(r, report)}`).join("\n")}

How to write it:
- WHERE THE OFFICE HAS WRITTEN A NOTE: carry it forward. Restate what it means for the money and what happens next, in plain words. Never contradict it, never doubt it, never repeat it back verbatim. "Change order billing" + sent 8/18 on 30-day terms becomes "CO billing, sent 8/18 — nothing to chase until 9/17".
- WHERE THERE IS NO NOTE: say what the facts alone support. "Sent 8/18 on 30-day terms — not chaseable yet" beats "Follow up with the customer".

Rules — these matter more than being interesting:
- Use ONLY the facts given. Never guess why a GC hasn't paid; never invent a conversation, a person, a promise or a date.
- Retainage is NOT late. Never describe it as owed now or as something to chase — it is released at close-out.
- NO DUE DATE RECORDED: say so plainly, and that setting one is what brings it into the ageing.
- Mention a row being a large share of the book, or a GC's only open item, at most once across all rows.
- Max 14 words. No trailing full stop. No quotes. Sentence case.
- Every row key you were given must appear exactly once.`;

  try {
    const client = new Anthropic({ apiKey });
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const wantedFacts = new Map(need.map((r) => [r.key, rowFacts(r, report)] as const));
    const at = new Date().toISOString();
    const merged: Record<string, RowNoteEntry> = { ...cache };
    let wrote = 0;
    for (const line of text.split("\n")) {
      const idx = line.indexOf("::");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const note = line.slice(idx + 2).trim().replace(/^["']|["'.]$/g, "").trim();
      const facts = wantedFacts.get(key);
      // Only keys we asked about. A model that invents a row must not be able
      // to attach a read to a receivable that doesn't exist.
      if (!facts || !note) continue;
      merged[key] = { note: note.slice(0, 200), hash: hashFacts(facts), at };
      wrote += 1;
    }
    if (wrote === 0) return { ok: false, error: "Couldn't read the drafted notes. Try again." };

    // Drop reads for rows that have left the book, so the cache can't grow
    // forever and can't resurrect a note if a key is ever reused.
    const liveKeys = new Set(report.rows.map((r) => r.key));
    for (const k of Object.keys(merged)) if (!liveKeys.has(k)) delete merged[k];

    await setCommercialSetting(CACHE_KEY, { notes: merged } satisfies RowNoteCache, null).catch(
      () => undefined
    );
    return {
      ok: true,
      wrote,
      notes: Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, v.note])),
    };
  } catch (err) {
    console.error("[receivable-row-notes] generate failed:", err);
    return { ok: false, error: `Couldn't draft the notes: ${modelErrorReason(err)}` };
  }
}

/**
 * Attach the reads to a report.
 *
 * Every row, including the ones a person has written on — `note` and `aiNote`
 * are two different columns and neither is ever folded into the other.
 */
export function withDraftedNotes(
  report: ReceivablesReport,
  notes: Record<string, string>
): ReceivablesReport {
  return {
    ...report,
    rows: report.rows.map((r) => ({ ...r, aiNote: notes[r.key] ?? null })),
  };
}

/**
 * What the send paths use: bring the reads up to date, then merge — best
 * effort, time-boxed.
 *
 * The scheduled report to Alex runs unattended, and it is the ONE place these
 * are most needed and least likely to be refreshed by hand. A slow or failing
 * model costs the reads; it must never cost the report, so the timeout races
 * the call and whatever is already cached still goes out.
 */
export async function ensureRowNotes(
  report: ReceivablesReport,
  timeoutMs = 25_000
): Promise<ReceivablesReport> {
  try {
    if (!rowNotesAvailable()) return report;
    const cached = await getCachedRowNotes(report);
    if (cached.staleCount === 0) {
      return Object.keys(cached.notes).length > 0 ? withDraftedNotes(report, cached.notes) : report;
    }
    const drafted = await Promise.race([
      generateRowNotes(report),
      new Promise<{ ok: false; error: string }>((resolve) =>
        setTimeout(() => resolve({ ok: false, error: "timeout" }), timeoutMs)
      ),
    ]);
    if (drafted.ok) return withDraftedNotes(report, drafted.notes);
    // Fall back to whatever was already written rather than sending nothing.
    return Object.keys(cached.notes).length > 0 ? withDraftedNotes(report, cached.notes) : report;
  } catch {
    return report;
  }
}
