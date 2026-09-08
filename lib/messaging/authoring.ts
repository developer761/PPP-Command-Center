"use server";

/**
 * Writing a training example by hand.
 *
 * Karan, 2026-09-08: "where else would we get the form" — the coverage page
 * named twenty-five gaps and offered no way to fill any of them.
 *
 * The gap it fills is real and not merely convenience. The corpus can only
 * grow two ways today: import from Hatch, which is switched off until Kate
 * settles what her grades meant, and grading what was imported, which cannot
 * create an example that does not already exist. So a rule Hatch never
 * demonstrated — the off-site-quote rule, refusing to name a price — has no
 * path into training at all. Someone who knows the right answer typing it out
 * IS the path.
 *
 * Two things this deliberately does NOT do:
 *
 *   - It does not mark an authored example as evidence of what Emily really
 *     says. Source is 'manual', and it stays distinguishable from 'hatch'
 *     forever, because an invented conversation is a statement of intent and a
 *     real one is a record of behaviour. Conflating them is how a corpus ends
 *     up teaching what somebody wished had happened.
 *   - It does not skip scrubbing. Hand-authored text should contain no real
 *     customer data, but "should" is not a guarantee — people paste. It runs
 *     the same scrubber the import path runs, and reports what it caught.
 */
import { messagingDb } from "./db";
import { scrub, residualPii } from "./pii";

export type AuthoredTurn = { who: "customer" | "agent"; text: string };

/** Rendered the same way imported transcripts are stored — plain text, one
 *  speaker per line — so a hand-written row and an imported row are the same
 *  kind of thing to every reader downstream. */
function renderTranscript(turns: AuthoredTurn[]): string {
  return turns
    .filter((t) => t.text.trim())
    .map((t) => `${t.who === "customer" ? "Customer" : "Emily"}: ${t.text.trim()}`)
    .join("\n");
}

export async function saveAuthoredExample(input: {
  turns: AuthoredTurn[];
  conduct: "good" | "bad";
  tagKeys: string[];
  note?: string;
  outcome?: string | null;
}): Promise<{ ok: true; id: string; scrubbed: string[] } | { ok: false; error: string }> {
  const turns = input.turns.filter((t) => t.text.trim());
  if (turns.length < 2) return { ok: false, error: "Write at least one message each way." };
  if (!turns.some((t) => t.who === "agent")) {
    return { ok: false, error: "An example needs at least one message from Emily — that is the part being taught." };
  }
  // A tag is what makes it countable. Untagged, it inflates the corpus total
  // while teaching nothing, which is the exact problem this page exists to fix.
  if (input.tagKeys.length === 0) {
    return { ok: false, error: "Pick at least one rule this shows." };
  }

  const raw = renderTranscript(turns);
  const { text, found } = scrub(raw);
  const leftover = residualPii(text);
  if (leftover.length) {
    return { ok: false, error: `Still looks like real customer data (${leftover.join(", ")}). Use a made-up name and number.` };
  }

  const sb = messagingDb();
  const { data, error } = await sb.from("sms_training_examples").insert({
    source: "manual",
    transcript: text,
    conduct: input.conduct,
    conduct_note: input.note?.trim() || null,
    outcome: input.outcome || null,
    pii_scrubbed: true,
    // Good examples are what retrieval copies from, so an authored good one is
    // usable immediately — the author is asserting the right answer, which is
    // the whole point. A bad one is kept and never offered as a model.
    approved: input.conduct === "good",
    graded_at: new Date().toISOString(),
  }).select("id").single();

  if (error) return { ok: false, error: error.message };

  const { error: tagErr } = await sb.from("sms_training_example_tags")
    .insert(input.tagKeys.map((tag_key) => ({
      example_id: data.id, tag_key, note: input.note?.trim() || null,
    })));
  if (tagErr) return { ok: false, error: tagErr.message };

  return { ok: true, id: data.id, scrubbed: found.filter((f) => f.count > 0).map((f) => f.kind) };
}

/** The rule list, for the picker. */
export async function activeTags(): Promise<{ key: string; section: string; label: string; what_to_look_for: string }[]> {
  const sb = messagingDb();
  const { data } = await sb.from("sms_training_tags")
    .select("key, section, label, what_to_look_for")
    .eq("is_active", true).order("sort_order");
  return data ?? [];
}
