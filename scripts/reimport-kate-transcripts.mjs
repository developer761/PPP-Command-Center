/**
 * Rebuild the imported transcripts from Kate's numbered transcript.
 *
 * Kate, 2026-09-15: "The turn numbers don't align with mine, and campaign msgs
 * are being attributed to Emily/the bot."
 *
 * import-kate-batch.mjs built each transcript from the JSON payload in her
 * sheet, which is Hatch's chatbot record: customer first, and every message we
 * sent labelled as the assistant. Her sheet carries the real conversation next
 * to it, numbered, timed and attributed. This rewrites each stored transcript
 * from that, IN PLACE, so every grade, rule tag and id stays attached.
 *
 * Finding the stored row: the old transcript is rebuilt exactly the way the
 * first import built it, scrubbed the same way, and matched on equality. A row
 * that does not match is reported and left alone.
 *
 * Repairs made on the old transcripts are carried across by matching the line
 * they changed to the same Emily message in the new one. One that cannot be
 * placed is reported and left alone.
 *
 * Dry run by default; --apply to write. Safe to re-run: a row already rebuilt
 * no longer matches its old form, so it is skipped.
 */
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { scrub, residualPii } from "../lib/messaging/pii.ts";
import { parseKateTranscript, storedTranscript } from "../lib/messaging/kate-transcript.ts";
import { turnsOf, changedTurns, applyRepairs } from "../lib/messaging/repair.ts";
import { selectAllIn } from "../lib/messaging/paging.ts";

const PDF = process.argv.find((a) => a.endsWith(".pdf"))
  ?? "/Users/karanmalhotra/Downloads/Karan Connect Hub Training Sheet - Batch 1 + 2.pdf";
const APPLY = process.argv.includes("--apply");

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const text = execFileSync("python3", ["-c", `
from pypdf import PdfReader
import sys
r = PdfReader(sys.argv[1])
sys.stdout.write("\\n".join((p.extract_text() or "") for p in r.pages))
`, PDF], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function firstJson(s) {
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{") d++;
    else if (s[i] === "}") { d--; if (d === 0) return s.slice(0, i + 1); }
  }
  return null;
}

const norm = (s) => s.replace(/\s+/g, " ").trim();


/**
 * Paged. PostgREST caps an unbounded select at 1,000 and this script MATCHES
 * against what it reads — so a short read makes existing conversations look
 * new, and re-running would duplicate every one it could not see. 1,294 rows
 * today.
 *
 * SUPERSEDED by scripts/import-rated-conversations.mjs, which reads Kate's
 * current export. Kept because it documents how the earlier format was
 * loaded; paged so that running it cannot quietly make a mess.
 */
async function readAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

const stored = await readAll((a, b) => sb.from("sms_training_examples")
  .select("id, transcript, conduct").eq("source", "hatch").order("id").range(a, b));
const byTranscript = new Map(stored.map((r) => [r.transcript, r]));

console.log(`\nKATE TRANSCRIPTS — ${APPLY ? "APPLYING" : "DRY RUN (pass --apply to write)"}\n`);

const rows = text.split(/(?=\{"data":\{"id")/).filter((p) => p.startsWith('{"data"'));
const plan = [];
const problems = [];

for (const row of rows) {
  const js = firstJson(row);
  if (!js) continue;
  let payload;
  try { payload = JSON.parse(js).data.payload; } catch { continue; }
  const msgs = payload.messages ?? [];
  if (!msgs.length) continue;

  // The old transcript, exactly as import-kate-batch.mjs made it.
  const old = scrub(msgs
    .map((m) => `${m.role === "user" ? "Customer" : "Emily"}: ${String(m.content ?? "").trim()}`)
    .filter((l) => l.length > 10)
    .join("\n")).text;
  const match = byTranscript.get(old);
  const label = `${payload.board?.name ?? "?"} · ${String(msgs[0]?.content ?? "").slice(0, 40)}`;
  if (!match) continue; // not imported (ungraded or blocked the first time), or already rebuilt

  // Most rows hold one conversation. A few hold several ("conversation 1 of
  // 2"), each numbered from [1]; the right one is the one the payload is.
  const tail = row.slice(js.length);
  const blocks = [];
  const footerRe = /(\d+)\s+turns\s*\|[^\n]*/g;
  const MARKER = /={3,}\s*conversation\s+\d+\s+of\s+\d+[^=]*={3,}/g;
  const FIRST = /\[1\]\s*\d{1,2}:\d{2}\s*\[(?:SMS|EMAIL|CALL)\]/;
  let from = 0, f, groupProblem = null;
  while ((f = footerRe.exec(tail)) !== null) {
    const seg = tail.slice(from, f.index);
    // Several conversations can share one footer ("17 turns" = 14 + 3). Each
    // restarts at [1], so each is checked on its own numbering, and together
    // they have to add up to her total.
    const parts = seg.split(MARKER).map((p) => {
      // The first real entry, not any "[1]": an email body can quote one.
      const s = p.search(FIRST);
      return s === -1 ? null : p.slice(s);
    }).filter(Boolean);
    const counts = parts.map((p) => (p.match(/\[\d+\]\s*\d{1,2}:\d{2}\s*\[(?:SMS|EMAIL|CALL)\]/g) ?? []).length);
    if (counts.reduce((a, b) => a + b, 0) !== Number(f[1])) {
      groupProblem = `her sheet says ${f[1]} turns, the conversations here hold ${counts.join(" + ")}`;
    } else {
      parts.forEach((p, n) => blocks.push(`${p}\n${counts[n]} turns |`));
    }
    from = f.index + f[0].length;
  }
  if (!blocks.length && groupProblem) { problems.push(`${label}: ${groupProblem}`); continue; }
  if (!blocks.length) { problems.push(`${label}: no numbered transcript beside the payload`); continue; }

  // Same conversation? Every customer message in the payload has to appear in
  // hers. Compared with whitespace removed, because the payload sometimes
  // joins two of her messages into one and the PDF rewraps lines.
  const squash = (s) => s.replace(/\s+/g, "");
  const payloadCustomer = msgs.filter((m) => m.role === "user").map((m) => squash(String(m.content ?? ""))).filter((c) => c.length > 3);
  let parsed = null, why = null, missingEg = null, pickedIdx = -1;
  for (const [n, b] of blocks.entries()) {
    const r = parseKateTranscript(b);
    if (!r.ok) { why = why ?? r.error; continue; }
    const hers = squash(r.turns.filter((t) => t.speaker === "Customer").map((t) => t.text).join(""));
    const missing = payloadCustomer.filter((c) => !hers.includes(c));
    if (missing.length === 0) { parsed = r; pickedIdx = n; break; }
    missingEg = missingEg ?? missing[0];
  }
  if (!parsed) {
    problems.push(`${label}: ${why ?? `a customer message is not in her transcript, e.g. "${missingEg?.slice(0, 50)}"`}`);
    continue;
  }
  const pickedOf = blocks.length > 1 ? ` (conversation ${pickedIdx + 1} of ${blocks.length})` : "";

  // Her transcript has what the payload never did: human agents and campaign
  // emails, which can carry a name the payload did not. The contact's name in
  // Hatch is sometimes a placeholder ("Ellya N/A"), so a capitalised word that
  // also appears in their email address counts as a name too: "Abidi" in
  // ellyaabidi@….
  const raw = storedTranscript(parsed.turns);
  const local = String(payload.contact?.email ?? "").split("@")[0].toLowerCase().replace(/[^a-z]/g, "");
  const fromEmail = local.length >= 4
    ? [...new Set((raw.match(/\b[A-Z][a-z]{3,}\b/g) ?? []).filter((w) => local.includes(w.toLowerCase())))]
        // A word also used in lowercase is a word, not a name. The scrub is
        // case-insensitive, so "Little" from an email would take out "a little".
        .filter((w) => !new RegExp(`\\b${w.toLowerCase()}\\b`).test(raw))
    : [];
  const names = [
    ...String(payload.contact?.name ?? "").split(/\s+/).filter((n) => n.length > 2 && !/^n\/?a$/i.test(n)),
    ...fromEmail,
  ];
  const rebuilt = scrub(raw, names).text;
  const leftover = residualPii(rebuilt);
  if (leftover.length) { problems.push(`${label}: still looks like customer data (${leftover.join(", ")})`); continue; }
  // Anything still sitting next to a scrubbed name is shown, not guessed at.
  const nearName = [...new Set(rebuilt.match(/\[NAME\][ \t]+[A-Z][a-z]{2,}/g) ?? [])];

  plan.push({ id: match.id, label: label + pickedOf, old, rebuilt, turns: parsed.turns, fromEmail, nearName });
}

const speakers = {};
for (const p of plan) for (const t of p.turns) speakers[t.speaker] = (speakers[t.speaker] ?? 0) + 1;
const reordered = plan.filter((p) => turnsOf(p.old)[0]?.speaker !== turnsOf(p.rebuilt)[0]?.speaker).length;

console.log(`stored hatch conversations : ${stored.length}`);
console.log(`matched to her sheet       : ${plan.length}`);
console.log(`first message changes     : ${reordered} (usually the campaign opener moving to T1)`);
console.log(`messages by speaker        : ${JSON.stringify(speakers)}`);
console.log(`not rebuilt, with reason   : ${problems.length}`);
for (const p of problems) console.log(`  - ${p}`);
const multi = plan.filter((p) => p.label.includes(" of "));
if (multi.length) console.log(`rows with several conversations: ${multi.map((p) => p.label).join(" | ")}`);
const emailNames = plan.filter((p) => p.fromEmail.length);
console.log(`names found via email address: ${emailNames.length ? emailNames.map((p) => p.fromEmail.join("/")).join(", ") : "none"}`);
const near = plan.filter((p) => p.nearName.length);
console.log(`still next to a scrubbed name (review): ${near.length ? near.map((p) => p.nearName.join(" ")).join(" | ") : "none"}`);
const unmatched = stored.filter((s) => !plan.some((p) => p.id === s.id));
console.log(`stored rows not in this PDF: ${unmatched.length}${unmatched.length ? " (left as they are)" : ""}`);

// The conversation Kate used to show the problem, so the dry run can be read
// against her message.
const sample = plan.find((p) => p.old.includes("11 lower office cabinets")) ?? plan[0];
if (sample) {
  console.log(`\nexample — ${sample.label}`);
  for (const t of turnsOf(sample.rebuilt)) console.log(`  T${t.turn} ${t.speaker}: ${t.text.slice(0, 70)}`);
}

// Repairs built on an old transcript.
// Paged: this rewrites what each repair is built on, so a repair that falls
// off the end of a truncated read keeps pointing at the old transcript and
// its changed turns stop lining up with anything.
const repairs = await selectAllIn(
  plan.map((p) => p.id),
  (chunk, from, to) => sb.from("sms_training_examples")
    .select("id, derived_from, transcript, approved").eq("source", "derived")
    .in("derived_from", chunk).order("id").range(from, to),
  "repairs built on these transcripts"
);
const repairPlan = [];
for (const r of repairs) {
  const p = plan.find((x) => x.id === r.derived_from);
  const changes = changedTurns(p.old, r.transcript);
  const newTurns = turnsOf(p.rebuilt);
  const fixes = [];
  let lost = null;
  for (const c of changes) {
    const at = newTurns.filter((t) => t.speaker === "Emily" && norm(t.text) === norm(c.from));
    if (at.length !== 1) { lost = `"${c.from.slice(0, 50)}" found ${at.length} times in the new transcript`; break; }
    fixes.push({ turn: at[0].turn, replacement: c.to, oldTurn: c.turn });
  }
  if (lost || !fixes.length) { console.log(`\nrepair ${r.id.slice(0, 8)} NOT carried across: ${lost ?? "no changed lines"}`); continue; }
  const applied = applyRepairs({ transcript: p.rebuilt, fixes });
  if (!applied.ok) { console.log(`\nrepair ${r.id.slice(0, 8)} NOT carried across: ${applied.error}`); continue; }
  repairPlan.push({ id: r.id, transcript: applied.transcript, fixes, approved: r.approved });
  console.log(`\nrepair ${r.id.slice(0, 8)}: ${fixes.map((f) => `old T${f.oldTurn} → T${f.turn}`).join(", ")}${r.approved ? " (was signed off; rebuilding unsigns it)" : ""}`);
}

if (!APPLY) { console.log("\nNothing written.\n"); process.exit(0); }

let updated = 0;
for (const p of plan) {
  const { error } = await sb.from("sms_training_examples").update({ transcript: p.rebuilt }).eq("id", p.id);
  if (error) console.log(`  update failed ${p.label}: ${error.message}`);
  else updated++;
}
let moved = 0;
for (const r of repairPlan) {
  const { error } = await sb.from("sms_training_examples").update({ transcript: r.transcript }).eq("id", r.id);
  if (error) { console.log(`  repair failed ${r.id}: ${error.message}`); continue; }
  // Per-turn fixes carry turn numbers, so they move with it.
  for (const f of r.fixes) {
    await sb.from("sms_example_findings").update({ turn_ordinal: f.turn })
      .eq("repair_id", r.id).eq("turn_ordinal", f.oldTurn);
  }
  moved++;
}
console.log(`\nrebuilt ${updated} transcripts, carried ${moved} repair(s) across\n`);
