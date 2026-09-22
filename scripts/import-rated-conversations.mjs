/**
 * Kate's rated conversations, into the training corpus.
 *
 *   npm run import:rated -- "/path/to/2026-09-22 hatch RATED CONVERSATIONS.csv"
 *   npm run import:rated -- "…csv" --apply      # actually write
 *
 * DRY RUN BY DEFAULT. It prints exactly what it would do and writes nothing
 * until --apply, because this is 1,234 conversations and getting it wrong
 * quietly is the failure mode that matters.
 *
 * ── WHAT MAKES THIS EXPORT BETTER THAN THE LAST ─────────────────────────
 *
 * Her defects and her good turns are in SEPARATE COLUMNS. The previous import
 * read a flattened PDF where the two ran together with no marker, so 68
 * findings could not be told apart and were dropped rather than guessed at —
 * filing a good turn as a failure would teach the bot to avoid the thing it
 * got right. A CSV keeps the boundary, so every finding here knows which it is.
 *
 * ── PII ─────────────────────────────────────────────────────────────────
 *
 * The transcripts are real customer conversations and the file carries names
 * and phone numbers in their own columns too. Every transcript is scrubbed
 * before it is stored, and any row where scrubbing leaves something behind is
 * REPORTED AND SKIPPED rather than imported — retrieval feeds these to a model,
 * and a name that survives ends up in a prompt.
 *
 * Contact Name and Contact Phone are never stored at all.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { parseCsvRows } from "../lib/messaging/csv.ts";
import { parseFindings } from "../lib/messaging/finding-line.ts";
import { scrub, residualPii } from "../lib/messaging/pii.ts";

const path = process.argv.find((a) => a.endsWith(".csv"));
const APPLY = process.argv.includes("--apply");
if (!path) {
  console.error('\n  npm run import:rated -- "/path/to/RATED CONVERSATIONS.csv" [--apply]\n');
  process.exit(1);
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

/** Her grade column maps straight onto conduct; the vocabulary is the same. */
const CONDUCT = { good: "good", mixed: "mixed", bad: "bad" };
/** Her Hatch status onto Emily's own outcome vocabulary. */
const OUTCOME = { success: "success", bailed_out: "bailout" };

let failed = false;

try {
  const rows = parseCsvRows(readFileSync(path, "utf8"));
  const H = rows[0].map((h) => h.replace(/^﻿/, "").trim());
  const body = rows.slice(1).filter((r) => r.some((c) => (c ?? "").trim()));
  const at = (frag) => H.findIndex((h) => h.toLowerCase().includes(frag.toLowerCase()));

  const I = {
    convo: at("Conversation ID"),
    transcript: at("Merged Transcript"),
    grade: at("Class A Grade"),
    defects: at("Class A Defects"),
    good: at("Class A Good Turns"),
    status: at("Hatch Status"),
  };
  for (const [k, v] of Object.entries(I)) {
    if (v < 0) throw new Error(`no column found for ${k}`);
  }

  console.log(`\nRATED CONVERSATIONS — ${APPLY ? "APPLYING" : "DRY RUN (pass --apply to write)"}\n`);
  console.log(`  rows in file: ${body.length}`);

  const prepared = [];
  let skippedPii = 0, skippedEmpty = 0, noGrade = 0;
  const sample = [];

  for (const r of body) {
    const sourceRef = (r[I.convo] ?? "").trim();
    const raw = (r[I.transcript] ?? "").trim();
    if (!sourceRef || !raw) { skippedEmpty++; continue; }

    const transcript = scrub(raw);
    const left = residualPii(transcript);
    if (left?.length) {
      // Never imported on a maybe. These are fed to a model.
      skippedPii++;
      if (sample.length < 3) sample.push(`${sourceRef}: ${left.slice(0, 2).join(", ")}`);
      continue;
    }

    const conduct = CONDUCT[(r[I.grade] ?? "").trim().toLowerCase()] ?? null;
    if (!conduct) noGrade++;

    prepared.push({
      sourceRef,
      transcript,
      conduct,
      outcome: OUTCOME[(r[I.status] ?? "").trim().toLowerCase()] ?? null,
      findings: [
        ...parseFindings(r[I.defects] ?? "", "fell_short"),
        ...parseFindings(r[I.good] ?? "", "did_well"),
      ],
    });
  }

  const findings = prepared.reduce((n, p) => n + p.findings.length, 0);
  console.log(`  usable:       ${prepared.length}`);
  console.log(`  skipped, no transcript or id: ${skippedEmpty}`);
  console.log(`  skipped, PII survived scrubbing: ${skippedPii}`);
  if (sample.length) sample.forEach((s) => console.log(`      ${s}`));
  console.log(`  no grade (imported, ungraded): ${noGrade}`);
  console.log(`\n  findings: ${findings}`);
  console.log(`    fell short: ${prepared.reduce((n, p) => n + p.findings.filter((f) => f.kind === "fell_short").length, 0)}`);
  console.log(`    did well:   ${prepared.reduce((n, p) => n + p.findings.filter((f) => f.kind === "did_well").length, 0)}`);

  // Only codes that exist as rules can be filed. Anything else is reported
  // rather than dropped into a foreign key error mid-run.
  const { data: ruleRows, error: ruleErr } = await sb.from("sms_class_a_rules").select("code");
  if (ruleErr) throw new Error(`could not read the rules: ${ruleErr.message}`);
  const known = new Set((ruleRows ?? []).map((r) => r.code));
  const unknown = new Set();
  for (const p of prepared) for (const f of p.findings) if (!known.has(f.code)) unknown.add(f.code);
  console.log(`\n  rules cited: ${new Set(prepared.flatMap((p) => p.findings.map((f) => f.code))).size}`);
  if (unknown.size) {
    console.log(`  ⚠ cited but NOT in sms_class_a_rules: ${[...unknown].join(", ")}`);
    console.log(`    those findings would be refused by the foreign key.`);
  }

  if (!APPLY) {
    console.log(`\nNothing written. Re-run with --apply.\n`);
    process.exit(0);
  }

  /* ── Write ─────────────────────────────────────────────────────────── */
  let examples = 0, wrote = 0;
  for (const p of prepared) {
    // LOOK UP, THEN INSERT OR UPDATE — not upsert.
    //
    // The unique index on source_ref is PARTIAL (`WHERE source_ref IS NOT
    // NULL`), because most rows have no external source and would otherwise
    // all collide on NULL. PostgREST cannot infer a partial index for its
    // ON CONFLICT clause, so `upsert({ onConflict: "source_ref" })` fails on
    // every single row with "no unique or exclusion constraint matching".
    // The index is real and does its job — a duplicate insert is refused with
    // 23505 — it just cannot be named this way.
    const fields = {
      source: "hatch",
      source_ref: p.sourceRef,
      transcript: p.transcript,
      conduct: p.conduct,
      outcome: p.outcome,
      pii_scrubbed: true,
      // NOT approved. A human decides what the bot is allowed to imitate;
      // importing is not that decision.
      approved: false,
    };

    const { data: found } = await sb.from("sms_training_examples")
      .select("id").eq("source_ref", p.sourceRef).maybeSingle();

    let ex, exErr;
    if (found) {
      // Re-graded. approved is deliberately NOT reset here — if somebody has
      // already vetted this conversation, a fresh export of the same rating
      // should not quietly un-approve it.
      const { approved: _ignored, ...update } = fields;
      ({ data: ex, error: exErr } = await sb.from("sms_training_examples")
        .update(update).eq("id", found.id).select("id").single());
    } else {
      ({ data: ex, error: exErr } = await sb.from("sms_training_examples")
        .insert(fields).select("id").single());
    }
    if (exErr) { failed = true; console.log(`  ✗ ${p.sourceRef}: ${exErr.message}`); continue; }
    examples++;

    // Replace this conversation's findings rather than adding to them, so a
    // re-import after re-grading reflects the new grading exactly.
    await sb.from("sms_example_findings").delete().eq("example_id", ex.id);
    if (!p.findings.length) continue;

    const { error: fErr } = await sb.from("sms_example_findings").insert(
      p.findings.filter((f) => known.has(f.code)).map((f) => ({
        example_id: ex.id,
        turn_ordinal: f.turnOrdinal,
        code: f.code,
        kind: f.kind,
        severity: f.severity,
        what: f.what,
        should_have: f.shouldHave,
      }))
    );
    if (fErr) { failed = true; console.log(`  ✗ findings for ${p.sourceRef}: ${fErr.message}`); continue; }
    wrote += p.findings.length;
  }

  console.log(`\n  ✓ ${examples} conversations, ${wrote} findings written`);
  console.log(`\n${failed ? "FINISHED WITH FAILURES" : "ALL GOOD"}\n`);
} catch (err) {
  failed = true;
  console.log(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
}

process.exit(failed ? 1 : 0);
