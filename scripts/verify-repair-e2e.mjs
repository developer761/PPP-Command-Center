/**
 * Repairs against the real database: several fixes per repair, and the two
 * sign-off guarantees.
 *
 * The unit tests prove the turn numbering and that fixes apply together. They
 * cannot prove that a fix is stored per turn and found again, that deleting a
 * repair takes its fixes with it, or that the database (not the screen) refuses
 * a repair that starts signed off or stays signed off after its text changes.
 *
 * Needs 20260915104418_repair_fixes_per_turn.sql applied. Cleanup in finally.
 */
import { createClient } from "@supabase/supabase-js";
import { applyRepairs, turnsOf, changedTurns } from "../lib/messaging/repair.ts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓  ${label}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  ✗  ${label}${extra ? "  " + extra : ""}`); }
};

let repairId = null;
const strays = [];

try {
  // A real conversation with at least two of Emily's lines to fix.
  const { data: originals } = await sb.from("sms_training_examples")
    .select("id, transcript").neq("source", "derived").in("conduct", ["mixed", "bad"]);
  const original = originals.find((o) => turnsOf(o.transcript).filter((t) => t.speaker === "Emily").length >= 2);
  const emily = turnsOf(original.transcript).filter((t) => t.speaker === "Emily");
  const [a, b] = [emily[0].turn, emily[1].turn];

  console.log(`\nREPAIRS — real schema  (T${a} and T${b} of ${original.id.slice(0, 8)})\n`);

  const applied = applyRepairs({
    transcript: original.transcript,
    fixes: [{ turn: a, replacement: "E2E fixed line A." }, { turn: b, replacement: "E2E fixed line B." }],
  });
  ok("two fixes apply to one conversation", applied.ok);

  /* ── Refused: a repair created already signed off ─────────────── */
  const signed = await sb.from("sms_training_examples").insert({
    source: "derived", derived_from: original.id, transcript: applied.transcript,
    conduct: "good", pii_scrubbed: true, approved: true,
  }).select("id").maybeSingle();
  if (signed.data?.id) strays.push(signed.data.id);
  ok("the database refuses a repair created already signed off", signed.error !== null);

  const { data: rep, error: repErr } = await sb.from("sms_training_examples").insert({
    source: "derived", derived_from: original.id, transcript: applied.transcript,
    conduct: "good", conduct_note: "e2e", pii_scrubbed: true, approved: false,
  }).select("id").single();
  ok("an unsigned repair is stored", !repErr, repErr?.message ?? "");
  repairId = rep.id;

  /* ── One finding per fixed turn, found again by repair ────────── */
  const { error: fErr } = await sb.from("sms_example_findings").insert([
    { example_id: original.id, repair_id: repairId, turn_ordinal: a, code: "A11", kind: "fell_short", what: "e2e a", should_have: "E2E fixed line A." },
    { example_id: original.id, repair_id: repairId, turn_ordinal: b, code: null, kind: "fell_short", what: "e2e b", should_have: "E2E fixed line B." },
  ]);
  ok("both fixes are stored per turn, with a code and without", !fErr, fErr?.message ?? "");

  const { data: back } = await sb.from("sms_example_findings")
    .select("turn_ordinal, code").eq("repair_id", repairId).order("turn_ordinal");
  ok("they come back by repair, in turn order",
     back?.length === 2 && back[0].turn_ordinal === a && back[1].turn_ordinal === b && back[0].code === "A11");

  const { data: stored } = await sb.from("sms_training_examples").select("transcript").eq("id", repairId).single();
  ok("the transcript alone still says which turns changed",
     JSON.stringify(changedTurns(original.transcript, stored.transcript).map((c) => c.turn)) === JSON.stringify([a, b]));

  /* ── Sign-off, then an edit unsigns it ────────────────────────── */
  await sb.from("sms_training_examples").update({ approved: true }).eq("id", repairId);
  const { data: s1 } = await sb.from("sms_training_examples").select("approved").eq("id", repairId).single();
  ok("signing it off sticks", s1.approved === true);

  await sb.from("sms_training_examples").update({ conduct_note: "e2e note only" }).eq("id", repairId);
  const { data: s2 } = await sb.from("sms_training_examples").select("approved").eq("id", repairId).single();
  ok("changing only the note leaves it signed off", s2.approved === true);

  await sb.from("sms_training_examples").update({ transcript: stored.transcript + " " }).eq("id", repairId);
  const { data: s3 } = await sb.from("sms_training_examples").select("approved").eq("id", repairId).single();
  ok("changing its text unsigns it, in the database", s3.approved === false);

  /* ── Deleting the repair takes its fixes with it ──────────────── */
  await sb.from("sms_training_examples").delete().eq("id", repairId);
  const { data: orphans } = await sb.from("sms_example_findings").select("id").eq("repair_id", repairId);
  ok("deleting a repair deletes its per-turn fixes", (orphans ?? []).length === 0);
  repairId = null;

  /* ── Kate's imported notes are untouched by any of this ───────── */
  const { error: impErr } = await sb.from("sms_example_findings").select("id").is("repair_id", null).limit(1);
  ok("imported notes are still readable apart from repairs", !impErr, impErr?.message ?? "");

} finally {
  for (const id of [repairId, ...strays].filter(Boolean)) {
    await sb.from("sms_training_examples").delete().eq("id", id);
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
