import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { getCommercialSetting, setCommercialSetting } from "@/lib/commercial/settings";
import type { ReceivablesReport } from "./receivables";

/**
 * The AR brief — one short read on the whole receivables book, for Alex.
 *
 * Karan, 2026-08-19: *"maybe we can have our own AI notes as well for alex."*
 *
 * Deliberately ONE summary at the top rather than a note per row. On a
 * fifteen-row book, per-row AI is fifteen API calls producing fifteen
 * restatements of a number already on the line. What a CEO actually wants from
 * this page is the sentence a finance director would say walking into his
 * office — where the money is concentrated, what's gone quiet, what to chase
 * first. That's one call and it's the part a person has to think about.
 *
 * It also keeps the human notes clearly human. Mary's column is her knowledge;
 * mixing generated text into the same field would make it impossible to tell
 * which is which, and Alex would stop trusting both.
 *
 * CACHED, keyed by a hash of the figures it was written from. A brief is
 * regenerated when the book actually changes — not on every page view, which
 * would spend a call and add seconds of latency to a report somebody refreshes
 * all day. Stale-but-labelled beats slow.
 *
 * Never blocks the page: the report renders from the cache, and generating is
 * an explicit action. A failure here costs a brief, never the report.
 */

const CACHE_KEY = "commercial_receivables_brief";
const MODEL = "claude-opus-5";

/**
 * Say what actually went wrong.
 *
 * Both model-backed features used to fail with "Couldn't … just now", which is
 * polite and useless: a bad key, no credit, no access to the model and a
 * network blip all read identically, so the only way to tell them apart was to
 * open Vercel's logs. The reason comes from the SDK's own error and is short
 * enough to sit in a banner. No key material is ever in it.
 */
export function modelErrorReason(err: unknown): string {
  const e = err as { status?: number; message?: string; error?: { error?: { message?: string } } };
  const detail = e?.error?.error?.message || e?.message || String(err);
  const short = detail.length > 160 ? `${detail.slice(0, 160)}…` : detail;
  if (e?.status === 401) return `the API key was rejected (401) — ${short}`;
  if (e?.status === 403) return `this key can't use ${MODEL} (403) — ${short}`;
  if (e?.status === 404) return `${MODEL} wasn't found for this key (404) — ${short}`;
  if (e?.status === 429) return `rate-limited or out of credit (429) — ${short}`;
  if (e?.status && e.status >= 500) return `Anthropic returned ${e.status} — ${short}`;
  return short;
}

export type ReceivablesBrief = {
  text: string;
  /** Hash of the figures this was written from — drives staleness. */
  inputHash: string;
  generatedAt: string;
};

/** What the brief was written from. Changing figures ⇒ new hash ⇒ stale.
 *
 *  Hashes `bookFingerprint` — the WHOLE book — never `report.rows`, which is
 *  whatever slice the calling page is showing. A brief is always written from
 *  the whole book, so comparing it against a filtered slice made every
 *  filtered view claim a current brief was stale, and Rewrite could never
 *  clear it: the rewrite re-hashed the whole book while the page kept
 *  comparing against its slice. */
function hashInput(report: ReceivablesReport): string {
  return createHash("sha256").update(report.bookFingerprint).digest("hex").slice(0, 16);
}

export async function getCachedBrief(
  report: ReceivablesReport
): Promise<{ brief: ReceivablesBrief | null; stale: boolean }> {
  const brief = await getCommercialSetting<ReceivablesBrief | null>(CACHE_KEY, null).catch(
    () => null
  );
  if (!brief?.text) return { brief: null, stale: true };
  return { brief, stale: brief.inputHash !== hashInput(report) };
}

export function briefAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Write a fresh brief. Returns the previous one on failure rather than
 * throwing — a report that loses its summary is a worse outcome than a summary
 * that's a few hours old.
 */
export async function generateBrief(
  report: ReceivablesReport
): Promise<{ ok: true; brief: ReceivablesBrief } | { ok: false; error: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "No Anthropic API key is configured on this environment." };
  }
  if (report.rows.length === 0) {
    return { ok: false, error: "Nothing is outstanding — there's nothing to summarise." };
  }

  const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  // Only the figures the brief needs. No contacts, no addresses, no documents.
  const lines = report.rows
    .slice(0, 60)
    .map((r) => {
      const age =
        r.kind === "retainage" ? "held to close-out" : r.daysOut === null ? "no due date" : r.daysOut > 0 ? `${r.daysOut} days late` : "not yet due";
      return `- ${r.jobName} (${r.accountName}) — ${money(r.openCents)}, ${r.kind}, ${age}${r.note ? `, note: "${r.note}"` : ", no note"}`;
    })
    .join("\n");

  const prompt = `You are writing a short receivables brief for the CEO of a commercial painting contractor. He reads it on his phone in the morning.

Total outstanding: ${money(report.totalOpenCents)}
Collectible now: ${money(report.dueNowCents)}
Past due: ${money(report.overdueCents)}
Retention held: ${money(report.retainageCents)}

Open items, largest first:
${lines}

Write 2-4 sentences of plain prose. No headings, no bullets, no preamble.

What to cover, in order of usefulness:
- Where the money is concentrated (if a few jobs dominate, say so with the numbers).
- What actually needs chasing, and why — an old item with no note is worse than a big one that was chased yesterday.
- Anything odd worth a second look.

Rules:
- Retention is NOT late. It is held until close-out. Never describe it as overdue or as a collection problem.
- Use the figures given. Do not estimate, extrapolate, or invent totals.
- If the notes show something was recently chased, credit that rather than flagging it as ignored.
- Be direct and specific. No filler like "it is important to note".`;

  try {
    const client = new Anthropic({ apiKey });
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) return { ok: false, error: "The model returned an empty brief. Try again." };

    const brief: ReceivablesBrief = {
      text,
      inputHash: hashInput(report),
      generatedAt: new Date().toISOString(),
    };
    // Best-effort cache. A failed write costs a re-generation, not the brief.
    await setCommercialSetting(CACHE_KEY, brief, null).catch(() => undefined);
    return { ok: true, brief };
  } catch (err) {
    console.error("[receivables-brief] generate failed:", err);
    return {
      ok: false,
      error: `Couldn't write the brief: ${modelErrorReason(err)}`,
    };
  }
}
