/**
 * Kate's graded conversations, Batch 1 + 2.
 *
 * 50 real conversations across 13 workspaces, 112 per-turn findings, 69 of
 * them carrying an explicit correction. The corpus had four examples and none
 * the bot could copy.
 *
 * Reads the PDF she sent. Each row carries a JSON payload with the full
 * message array — a better transcript source than re-parsing the flattened
 * table, which runs columns together. Her grade and findings are parsed from
 * the text that follows each payload.
 *
 * PII goes through the same scrubber the rest of the import path uses. Dry run
 * by default; --apply to write. Idempotent on the scrubbed transcript.
 */
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { scrub, residualPii } from "../lib/messaging/pii.ts";

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

/** Brace-match one JSON object from the start of a string. */
function firstJson(s) {
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{") d++;
    else if (s[i] === "}") { d--; if (d === 0) return s.slice(0, i + 1); }
  }
  return null;
}

const SEV = { mild: "mild", medium: "medium", critical: "critical", crit: "critical" };

/** Her per-turn findings: T8 [A11 | Redundant Ask/mild] what -> SHOULD HAVE: x */
/**
 * WHAT THIS CANNOT RECOVER, and why it is left out rather than guessed.
 *
 * Her sheet has two separate columns — "Where It Fell Short" and "Claude Good
 * Turn(s)" — and both contain entries shaped `T8 [A11 | Name/sev] ...`. The
 * PDF flattens the table, so the two columns run together with no marker
 * between them and there is no way to tell which column an entry came from.
 *
 * A finding carrying "-> SHOULD HAVE:" is certainly a shortfall: nobody writes
 * a correction for something that went right. Those are imported as
 * fell_short. Everything else is ambiguous and is REPORTED rather than filed
 * under a guess — labelling a good turn as a failure would teach the bot to
 * avoid the thing it got right, which is worse than not importing it.
 *
 * A CSV export keeps the column boundary. That is the fix.
 */
function parseFindings(segment) {
  const out = [];
  const re = /T(\d+)\s*\[(A\d+)[^\]|]*(?:\|\s*([^\]/]+?)\s*\/?\s*([a-z]+)?)?\]\s*([\s\S]*?)(?=T\d+\s*\[A\d+|$)/g;
  let m;
  while ((m = re.exec(segment)) !== null) {
    const [, turn, code, , sevRaw, body] = m;
    const parts = body.split(/->\s*SHOULD HAVE:\s*/);
    const what = parts[0].trim();
    if (!what) continue;
    out.push({
      turn_ordinal: Number(turn),
      code,
      kind: parts[1] ? "fell_short" : null,
      severity: SEV[(sevRaw ?? "").toLowerCase()] ?? null,
      what: what.slice(0, 2000),
      should_have: parts[1]?.trim().slice(0, 2000) || null,
    });
  }
  return out;
}

const rows = text.split(/(?=\{"data":\{"id")/).filter((p) => p.startsWith('{"data"'));
console.log(`\nKATE BATCH 1 + 2 — ${APPLY ? "APPLYING" : "DRY RUN (pass --apply to write)"}\n`);
console.log(`rows found: ${rows.length}\n`);

const parsed = [];
for (const row of rows) {
  const js = firstJson(row);
  if (!js) continue;
  let payload;
  try { payload = JSON.parse(js).data.payload; } catch { continue; }

  const msgs = payload.messages ?? [];
  if (!msgs.length) continue;

  const transcript = msgs
    .map((m) => `${m.role === "user" ? "Customer" : "Emily"}: ${String(m.content ?? "").trim()}`)
    .filter((l) => l.length > 10)
    .join("\n");

  const tail = row.slice(js.length);

  // The grade is glued to the batch number — "batch 1bad" — so a word-boundary
  // match never fired: "1" and "b" are both word characters, so there is no
  // boundary between them. Anchoring on "batch N" is exact.
  const grade = (tail.match(/batch\s*\d+\s*(good|mid|bad)/i) ?? [])[1];

  // Findings stop at the "Why It Stopped" column, which is prefixed with a
  // class label. Without this cut they bleed into the NEXT row's metadata.
  const stop = tail.search(/\n?(?:CAPABILITY|RULE|BUILD|[A-Z]{4,})\s*[a-z]/);
  const findingSeg = stop > 0 ? tail.slice(0, stop) : tail;

  parsed.push({
    board: payload.board?.name ?? null,
    campaign: payload.campaign?.name ?? null,
    endReason: payload.end_reason ?? null,
    grade: grade ? grade.toLowerCase() : null,
    transcript,
    findings: parseFindings(findingSeg),
  });
}

const conductOf = (g) => (g === "mid" ? "mixed" : g === "good" ? "good" : g === "bad" ? "bad" : null);

let usable = 0, noGrade = 0, blocked = 0, totalFindings = 0, withCorrection = 0;
const prepared = [];
for (const p of parsed) {
  const { text: clean, found } = scrub(p.transcript);
  const leftover = residualPii(clean);
  const conduct = conductOf(p.grade);
  if (leftover.length) { blocked++; continue; }
  if (!conduct) { noGrade++; }
  totalFindings += p.findings.length;
  withCorrection += p.findings.filter((f) => f.should_have).length;
  if (conduct) usable++;
  prepared.push({ ...p, conduct, clean, redacted: found.filter((f) => f.count > 0) });
}

console.log(`parsed        : ${parsed.length}`);
console.log(`with a grade  : ${usable}   (good/mid/bad)`);
console.log(`no grade found: ${noGrade}`);
console.log(`blocked on PII: ${blocked}`);
const ambiguous = totalFindings - withCorrection;
console.log(`findings      : ${totalFindings}`);
console.log(`  certain     : ${withCorrection} carry a correction, so are certainly shortfalls`);
console.log(`  ambiguous   : ${ambiguous} could be either column — NOT imported, see the note in this file`);
const byGrade = {};
for (const p of prepared) byGrade[p.conduct ?? "ungraded"] = (byGrade[p.conduct ?? "ungraded"] ?? 0) + 1;
console.log(`by grade      : ${JSON.stringify(byGrade)}`);
console.log(`workspaces    : ${[...new Set(prepared.map((p) => p.board))].filter(Boolean).length}`);

if (!APPLY) { console.log("\nNothing written.\n"); process.exit(0); }

// Her codes, mapped to our rules by migration 200. Retrieval selects BY RULE,
// so an example imported without one is used but never aimed — the bot would
// not preferentially see her address examples when it is about to ask for an
// address.
const { data: codeRows } = await sb.from("sms_audit_codes").select("code, tag_key");
const tagOf = new Map((codeRows ?? []).filter((c) => c.tag_key).map((c) => [c.code, c.tag_key]));
console.log(`codes mapped to a rule: ${tagOf.size} of ${(codeRows ?? []).length}`);

let inserted = 0, skipped = 0, findingRows = 0, tagRows = 0, untagged = 0;
for (const p of prepared) {
  if (!p.conduct) { skipped++; continue; }

  const { data: existing } = await sb.from("sms_training_examples")
    .select("id").eq("transcript", p.clean).maybeSingle();
  if (existing) { skipped++; continue; }

  const { data, error } = await sb.from("sms_training_examples").insert({
    source: "hatch",
    transcript: p.clean,
    conduct: p.conduct,
    conduct_note: p.findings.length
      ? p.findings.map((f) => `T${f.turn_ordinal}: ${f.what}${f.should_have ? ` Should have: ${f.should_have}` : ""}`).join(" ")
      : null,
    pii_scrubbed: true,
    // Only a good conversation is something to copy. Mid and bad are kept as
    // warnings and never offered as a model.
    approved: p.conduct === "good",
    graded_at: new Date().toISOString(),
  }).select("id").single();
  if (error) { console.log(`  insert failed: ${error.message}`); continue; }
  inserted++;

  // Tag the example with every rule its findings touch. A conversation that
  // fell short on tone AND on address teaches both, and retrieval scores on
  // how many live rules an example demonstrates.
  const tags = [...new Set(p.findings.map((f) => tagOf.get(f.code)).filter(Boolean))];
  if (tags.length) {
    const { error: tErr } = await sb.from("sms_training_example_tags")
      .insert(tags.map((tag_key) => ({ example_id: data.id, tag_key })));
    if (tErr) console.log(`  tags failed: ${tErr.message}`);
    else tagRows += tags.length;
  } else {
    untagged++;
  }

  const certain = p.findings.filter((f) => f.kind);
  if (certain.length) {
    const { error: fErr } = await sb.from("sms_example_findings")
      .insert(certain.map((f) => ({ ...f, example_id: data.id })));
    if (fErr) console.log(`  findings failed: ${fErr.message}`);
    else findingRows += certain.length;
  }
}
console.log(`\ninserted ${inserted}, skipped ${skipped}`);
console.log(`findings written ${findingRows}, rule tags written ${tagRows}`);
console.log(`examples with NO rule attached: ${untagged} — these are used but not aimed\n`);
