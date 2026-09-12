"use server";

/**
 * The repair queue, and what a repair becomes.
 *
 * A repair is CONSTRUCTED. It is built from a real transcript, so it looks
 * real, and nothing in the text would tell you the customer never received it.
 * Three things keep that honest and all three are enforced rather than
 * documented: source='derived' for ever, derived_from pointing at the
 * original, and a database trigger that refuses to let one be created already
 * approved.
 */
import { messagingDb } from "./db";
import { assertMessagingAccess } from "./auth";
import { applyRepair, repairNote, linesOf } from "./repair";
import { scrub, residualPii } from "./pii";

export type RepairCandidate = {
  exampleId: string;
  transcript: string;
  conduct: string | null;
  findings: {
    id: string;
    turnOrdinal: number | null;
    code: string | null;
    severity: string | null;
    what: string;
    shouldHave: string | null;
  }[];
  /** Repairs already made from this conversation. */
  repairs: { id: string; approved: boolean; note: string | null }[];
};

/**
 * Conversations worth repairing: graded mid or bad, carrying a correction.
 *
 * A conversation with no correction says what went wrong but not what should
 * have happened, and repairing it would be inventing a standard rather than
 * applying one.
 */
export async function repairQueue(limit = 25): Promise<RepairCandidate[]> {
  await assertMessagingAccess();
  const sb = messagingDb();

  const { data: findings } = await sb
    .from("sms_example_findings")
    .select("id, example_id, turn_ordinal, code, severity, what, should_have")
    .not("should_have", "is", null)
    .order("severity");
  if (!findings?.length) return [];

  const ids = [...new Set(findings.map((f) => f.example_id))];
  const [{ data: examples }, { data: derived }] = await Promise.all([
    sb.from("sms_training_examples")
      .select("id, transcript, conduct")
      .in("id", ids).in("conduct", ["mixed", "bad"]),
    sb.from("sms_training_examples")
      .select("id, derived_from, approved, conduct_note")
      .eq("source", "derived").in("derived_from", ids),
  ]);

  const byExample = new Map<string, RepairCandidate>();
  for (const e of examples ?? []) {
    byExample.set(e.id, {
      exampleId: e.id, transcript: e.transcript, conduct: e.conduct,
      findings: [],
      repairs: (derived ?? []).filter((d) => d.derived_from === e.id)
        .map((d) => ({ id: d.id, approved: d.approved, note: d.conduct_note })),
    });
  }
  for (const f of findings) {
    const c = byExample.get(f.example_id);
    if (!c) continue;
    c.findings.push({
      id: f.id, turnOrdinal: f.turn_ordinal, code: f.code,
      severity: f.severity, what: f.what, shouldHave: f.should_have,
    });
  }

  // The worst first — a critical finding is the one most worth fixing, and a
  // conversation already repaired drops to the bottom rather than vanishing so
  // a second finding on it can still be worked.
  const sev = (s: string | null) => (s === "critical" ? 0 : s === "medium" ? 1 : 2);
  return [...byExample.values()]
    .filter((c) => c.findings.length)
    .sort((a, b) =>
      a.repairs.length - b.repairs.length
      || sev(a.findings[0].severity) - sev(b.findings[0].severity))
    .slice(0, limit);
}

export type SaveRepair =
  | { ok: true; id: string; changed: { from: string; to: string } }
  | { ok: false; error: string };

export async function saveRepair(input: {
  exampleId: string;
  findingId: string;
  lineIndex: number;
  replacement: string;
  tagKeys: string[];
}): Promise<SaveRepair> {
  await assertMessagingAccess();
  const sb = messagingDb();

  const [{ data: original }, { data: finding }] = await Promise.all([
    sb.from("sms_training_examples").select("id, transcript").eq("id", input.exampleId).maybeSingle(),
    sb.from("sms_example_findings").select("id, what, should_have").eq("id", input.findingId).maybeSingle(),
  ]);
  if (!original) return { ok: false, error: "That conversation no longer exists." };
  if (!finding) return { ok: false, error: "That correction no longer exists." };

  const applied = applyRepair({
    transcript: original.transcript,
    lineIndex: input.lineIndex,
    replacement: input.replacement,
  });
  if (!applied.ok) return { ok: false, error: applied.error };

  // Scrubbed again. Somebody writing a replacement line will type a name or a
  // number without thinking, and the original being clean says nothing about
  // what was just added.
  const { text } = scrub(applied.transcript);
  const leftover = residualPii(text);
  if (leftover.length) {
    return { ok: false, error: `That still looks like real customer data (${leftover.join(", ")}). Use a made-up name or number.` };
  }

  const { data, error } = await sb.from("sms_training_examples").insert({
    source: "derived",
    derived_from: original.id,
    derived_from_finding: finding.id,
    transcript: text,
    conduct: "good",
    conduct_note: repairNote({
      what: finding.what, shouldHave: finding.should_have,
      from: applied.changed.from, to: applied.changed.to,
    }),
    pii_scrubbed: true,
    // NOT approved. The trigger refuses it anyway, and a repair nobody has
    // read is somebody's opinion about what good looks like.
    approved: false,
    graded_at: new Date().toISOString(),
  }).select("id").single();
  if (error) return { ok: false, error: error.message };

  if (input.tagKeys.length) {
    await sb.from("sms_training_example_tags").insert(
      input.tagKeys.map((tag_key) => ({ example_id: data.id, tag_key }))
    );
  }

  return { ok: true, id: data.id, changed: applied.changed };
}

/**
 * Sign a repair off, which is what makes the bot able to copy it.
 *
 * Deliberately a separate act from writing it. The database will not accept a
 * repair created already approved, so this is the only way one becomes
 * something the bot imitates — and it exists so somebody reads the whole
 * repaired conversation rather than just the line they changed.
 */
export async function approveRepair(input: { id: string; approve: boolean }): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const userId = await assertMessagingAccess();
  const sb = messagingDb();
  const { error } = await sb.from("sms_training_examples")
    .update({ approved: input.approve, graded_by: userId, graded_at: new Date().toISOString() })
    .eq("id", input.id).eq("source", "derived");
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** The repaired conversation, for reviewing before signing it off. */
export async function repairPreview(id: string): Promise<{
  transcript: string; note: string | null; approved: boolean; originalTranscript: string | null;
} | null> {
  await assertMessagingAccess();
  const sb = messagingDb();
  const { data } = await sb.from("sms_training_examples")
    .select("transcript, conduct_note, approved, derived_from").eq("id", id).maybeSingle();
  if (!data) return null;
  const { data: orig } = data.derived_from
    ? await sb.from("sms_training_examples").select("transcript").eq("id", data.derived_from).maybeSingle()
    : { data: null };
  return {
    transcript: data.transcript, note: data.conduct_note,
    approved: data.approved, originalTranscript: orig?.transcript ?? null,
  };
}

/** Line numbers for the screen, so a person can choose which one to rewrite. */
export async function transcriptLines(transcript: string) {
  await assertMessagingAccess();
  return linesOf(transcript);
}
