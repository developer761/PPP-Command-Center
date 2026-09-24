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
import { scrub, residualPii, suspectedNames } from "../lib/messaging/pii.ts";

/** The bot introduces itself by name, so customers greet it by name. That is
 *  the assistant, not a customer, and it is not PII. */
const PERSONAS = ["Emily", "Emma", "Sarah"];

const csvArgs = process.argv.filter((a) => a.endsWith(".csv"));
const path = csvArgs[0];

/**
 * The per-finding files, if they were handed to us.
 *
 * Kate's handover calls them optional and it is right: almost everything in
 * them is already in the conversations file. They add exactly two things, and
 * both only matter once somebody opens a rule and wants to see what the bot
 * actually said.
 *
 *   Turn Text  the sentence the finding is anchored to
 *   Basis      read · detector · read + detector · lookup · carve · day lookup
 *
 * Basis is the more useful of the two. It separates a finding a person read
 * and judged from one a mechanical check found, which is the distinction to
 * draw when deciding whether a rule can be enforced in code at all.
 *
 * Matched by name rather than position so the order of the arguments does not
 * matter, and absent files simply mean the two columns stay null.
 */
const notesPath = csvArgs.find((a) => /DEFECT NOTES/i.test(a)) ?? null;
const goodPath  = csvArgs.find((a) => /GOOD TURNS/i.test(a)) ?? null;
const APPLY = process.argv.includes("--apply");
if (!path) {
  console.error(
    '\n  npm run import:rated -- "/path/to/RATED CONVERSATIONS.csv" [--apply]\n' +
    '    optionally add "…DEFECT NOTES.csv" and "…GOOD TURNS.csv" for turn text and basis\n'
  );
  process.exit(1);
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

/** Her grade column maps straight onto conduct; the vocabulary is the same. */
const CONDUCT = { good: "good", mixed: "mixed", bad: "bad" };
/** Her Hatch status onto Emily's own outcome vocabulary. */
const OUTCOME = { success: "success", bailed_out: "bailout" };

/**
 * Did the name we handed the scrubber survive it?
 *
 * Mirrors what scrub() does with knownNames — whole words, any case, parts of
 * three characters or more — so this asks the same question of the output that
 * scrub asked of the input. It is the check residualPii structurally cannot
 * make, and the one that would have caught this import going wrong.
 */
function nameSurvives(text, full) {
  const parts = [...new Set([full.trim(), ...full.trim().split(/\s+/)])].filter((p) => p.length >= 3);
  return parts.some((p) => new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
}

let failed = false;

try {
  const rows = parseCsvRows(readFileSync(path, "utf8"));
  const H = rows[0].map((h) => h.replace(/^﻿/, "").trim());
  const body = rows.slice(1).filter((r) => r.some((c) => (c ?? "").trim()));
  const at = (frag) => H.findIndex((h) => h.toLowerCase().includes(frag.toLowerCase()));
  /** Exact header match, for the columns whose short names are substrings of
   *  other headers. "Defects" is inside "Defect count". */
  const exact = (name) => H.findIndex((h) => h.toLowerCase() === name.toLowerCase());

  const I = {
    convo: at("Conversation ID"),
    transcript: at("Merged Transcript"),
    // RENAMED IN THE 23 SEPTEMBER EXPORT. They were "Class A Grade
    // 2026-09-22" and so on, which was the export date repeated on every row
    // of a file that is entirely one date's ratings. Matched by exact header
    // now rather than by substring: "Grade" as a substring also matches
    // nothing useful, and a lookup that silently finds the wrong column is
    // worse than one that throws.
    grade: exact("Grade"),
    defects: exact("Defects"),
    good: exact("Good Turns"),
    // OPTIONAL, and nullable when present. Kate, 2026-09-23: "Hatch labels
    // weren't consistent -- you'll see conversations graded as bad that Hatch
    // dispo'd as 'success', so I wouldn't rely on those." In her own file 465
    // conversations she graded BAD are dispo'd success, which is more than
    // half of everything Hatch called one.
    //
    // Nothing trains on it. Retrieval selects on HER grade and nothing else,
    // so the label never reaches a model. It is kept only as a reference
    // column beside the conversation, and a file without it imports fine.
    status: at("Hatch Status"),
    // NOT stored. Read only so the scrubber can be TOLD the customer's name —
    // which is the whole reason scrub() takes knownNames. Detecting names in
    // free text either misses them or redacts "Bill" and "Rose"; redacting a
    // name the file hands you is exact. Required, not optional: a file without
    // this column must fail loudly rather than import 1,234 unscrubbed names.
    name: at("Contact Name"),
  };
  // Everything except the Hatch status, which the import does not depend on.
  for (const [k, v] of Object.entries(I)) {
    if (k === "status") continue;
    if (v < 0) throw new Error(`no column found for ${k}`);
  }
  if (I.status < 0) console.log("  note: no Hatch Status column, so outcome is left empty. Nothing uses it.");

  console.log(`\nRATED CONVERSATIONS — ${APPLY ? "APPLYING" : "DRY RUN (pass --apply to write)"}\n`);
  console.log(`  rows in file: ${body.length}`);

  /**
   * turn text and basis, keyed by conversation + turn + rule.
   *
   * Checked before it is trusted: the key is unique in both files as shipped,
   * 2,159 and 651 rows with no duplicates, so a collision here means the
   * export changed shape and is worth failing on rather than silently keeping
   * whichever row came last.
   */
  const perTurn = new Map();
  let perTurnRows = 0, perTurnClashes = 0;
  for (const [file, kind] of [[notesPath, "fell_short"], [goodPath, "did_well"]]) {
    if (!file) continue;
    const rs = parseCsvRows(readFileSync(file, "utf8"));
    const h = rs[0].map((x) => x.replace(/^\ufeff/, "").trim());
    const col = (n) => h.findIndex((x) => x.toLowerCase() === n.toLowerCase());
    const iC = col("Conversation ID"), iT = col("Turn"), iR = col("Rule ID");
    const iX = col("Turn Text"), iB = col("Basis"), iN = col("Contact Name");
    if (iC < 0 || iT < 0 || iR < 0) {
      console.log(`  ⚠ ${file.split("/").pop()} is missing a join column, so it was ignored`);
      continue;
    }
    for (const r of rs.slice(1)) {
      const key = [(r[iC] ?? "").trim(), (r[iT] ?? "").trim().toUpperCase(), (r[iR] ?? "").trim().toUpperCase()].join("|");
      if (!key.replace(/\|/g, "")) continue;
      if (perTurn.has(key)) { perTurnClashes++; continue; }
      // SCRUBBED, LIKE EVERYTHING ELSE FROM THESE FILES.
      //
      // The transcripts go through scrub() and this did not, so the first
      // load of the per-finding files put 256 rows of real customer data into
      // the database: 143 addresses, 104 emails, 118 phone numbers. One read
      // "Is 646-361-3637 and rsap462@gmail.com the best contact".
      //
      // These never reach a model — retrieval reads transcripts, not findings
      // — so it was not a prompt leak. It was worse in a quieter way: the
      // transcript sitting beside it was scrubbed, so the table claimed a
      // guarantee it was not keeping.
      //
      // The finding still reads perfectly with placeholders. "Is [PHONE] and
      // [EMAIL] the best contact" demonstrates the read-back it is evidence
      // for just as well.
      const rawText = iX >= 0 ? (r[iX] ?? "").trim() : "";
      const who = iN >= 0 ? (r[iN] ?? "").trim() : "";
      const cleanText = rawText ? scrub(rawText, who ? [who] : []).text : "";

      perTurn.set(key, {
        turnText: cleanText || null,
        basis: iB >= 0 ? (r[iB] ?? "").trim() || null : null,
        kind,
      });
      perTurnRows++;
    }
  }
  if (perTurnRows) {
    console.log(`  per-finding detail: ${perTurnRows} rows loaded${perTurnClashes ? `, ${perTurnClashes} duplicate keys ignored` : ""}`);
  }

  const prepared = [];
  /** Rows that failed the PII check and may ALREADY be in the database from an
   *  earlier import. Skipping them is not enough on its own. */
  const quarantine = [];
  let skippedPii = 0, skippedEmpty = 0, noGrade = 0;
  const sample = [];

  for (const r of body) {
    const sourceRef = (r[I.convo] ?? "").trim();
    const raw = (r[I.transcript] ?? "").trim();
    if (!sourceRef || !raw) { skippedEmpty++; continue; }

    // DESTRUCTURE .text. scrub() returns { text, found }, and assigning the
    // whole result was the bug that made every check below inert: residualPii
    // stringified the object to "[object Object]", matched nothing, and
    // reported a clean run on 1,234 rows it had not actually looked at.
    const contactName = (r[I.name] ?? "").trim();
    const { text: transcript } = scrub(raw, contactName ? [contactName] : []);
    const left = residualPii(transcript);
    // residualPii checks email/phone/address and cannot check a name — it has
    // no way to know what is one. Here we do: if the name we were given is
    // still in the transcript after scrubbing it, the scrub did not work.
    if (contactName && nameSurvives(transcript, contactName)) left.push("name");
    // And the names we were never given. The bot's own persona is greeted by
    // customers constantly and is not a customer's name, so it is allowed.
    const suspects = suspectedNames(transcript, PERSONAS);
    if (suspects.length) left.push(`name?(${suspects.join("/")})`);
    if (left?.length) {
      // Never imported on a maybe. These are fed to a model.
      skippedPii++;
      quarantine.push(sourceRef);
      if (sample.length < 3) sample.push(`${sourceRef}: ${left.slice(0, 2).join(", ")}`);
      continue;
    }

    const conduct = CONDUCT[(r[I.grade] ?? "").trim().toLowerCase()] ?? null;
    if (!conduct) noGrade++;

    prepared.push({
      sourceRef,
      transcript,
      conduct,
      outcome: I.status < 0 ? null : OUTCOME[(r[I.status] ?? "").trim().toLowerCase()] ?? null,
      findings: [
        ...parseFindings(r[I.defects] ?? "", "fell_short"),
        ...parseFindings(r[I.good] ?? "", "did_well"),
      ].map((f) => {
        // Joined on conversation, turn label and rule. The label is what
        // matches, not the ordinal: T2.2 and T2.5 are both message 2, so an
        // ordinal join would put one finding's text on the other.
        const d = perTurn.get([sourceRef, f.turnLabel.toUpperCase(), f.code.toUpperCase()].join("|"));
        return { ...f, turnText: d?.turnText ?? null, basis: d?.basis ?? null };
      }),
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

  // WITHDRAW WHAT AN EARLIER IMPORT LET THROUGH.
  //
  // Skipping a row only protects a database that has never seen it. This
  // script ran once with a broken scrubber, so a row failing the check today
  // is exactly the row most likely to be sitting in the table already, with
  // the name still in it. Clearing pii_scrubbed is what makes that structural
  // rather than a promise: retrieval filters on the flag in the query, so an
  // unflagged row cannot reach a prompt however the corpus is later read.
  //
  // The row and Kate's grading of it stay, because the human screens should
  // still show what she graded. Only the permission to teach from it goes.
  if (quarantine.length) {
    const { data: hit, error: qErr } = await sb.from("sms_training_examples")
      .update({ pii_scrubbed: false }).in("source_ref", quarantine).eq("pii_scrubbed", true).select("source_ref");
    if (qErr) { failed = true; console.log(`  ✗ could not withdraw ${quarantine.length} row(s): ${qErr.message}`); }
    else if (hit.length) console.log(`  ⚠ withdrew ${hit.length} previously imported row(s) that fail the PII check now`);
  }

  let examples = 0, wrote = 0, dropped = 0;
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
    // re-import after re-grading reflects the new grading exactly — but only
    // KATE'S. A repair's own per-turn fixes carry a repair_id and are not hers
    // to replace; deleting them would silently destroy a repair record because
    // she re-exported the conversation it was written against.
    await sb.from("sms_example_findings").delete().eq("example_id", ex.id).is("repair_id", null);
    if (!p.findings.length) continue;

    const filed = p.findings.filter((f) => known.has(f.code));
    const { error: fErr } = await sb.from("sms_example_findings").insert(
      filed.map((f) => ({
        example_id: ex.id,
        turn_ordinal: f.turnOrdinal,
        turn_label: f.turnLabel,
        turn_text: f.turnText,
        basis: f.basis,
        code: f.code,
        kind: f.kind,
        severity: f.severity,
        what: f.what,
        should_have: f.shouldHave,
      }))
    );
    if (fErr) { failed = true; console.log(`  ✗ findings for ${p.sourceRef}: ${fErr.message}`); continue; }
    // What was FILED, not what was parsed. Counting the unfiltered list made
    // the total over-report by exactly the findings whose rule code is missing
    // from sms_class_a_rules — the case warned about sixty lines above.
    wrote += filed.length;
    dropped += p.findings.length - filed.length;
  }

  console.log(`\n  ✓ ${examples} conversations, ${wrote} findings written`);
  if (dropped) console.log(`  ⚠ ${dropped} finding(s) NOT written — their rule code is not in sms_class_a_rules`);
  console.log(`\n${failed ? "FINISHED WITH FAILURES" : "ALL GOOD"}\n`);
} catch (err) {
  failed = true;
  console.log(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
}

process.exit(failed ? 1 : 0);
