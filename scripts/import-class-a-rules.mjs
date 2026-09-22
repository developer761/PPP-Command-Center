/**
 * Load Kate's Class A rules into the database.
 *
 *   npm run import:rules -- "/path/to/2026-09-22 hatch CLASS A RULES.csv"
 *
 * Idempotent: re-running with a fresh export updates in place. She re-issues
 * this sheet as rules are merged, retired and reworded, so being safe to run
 * twice is the point rather than a nicety.
 *
 * THE RATER-ONLY COLUMN GOES SOMEWHERE ELSE. Kate's heading says "NEVER give
 * this to a bot", and it is written to sms_class_a_rule_notes, a different
 * table the prompt builder never reads. See lib/messaging/class-a-rules.ts.
 *
 * Nothing here can send a message. It writes two tables and reads nothing else.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { parseClassARules, promptable, forPrompt } from "../lib/messaging/class-a-rules.ts";

const path = process.argv[2];
if (!path) {
  console.error("\n  Give me the CSV:\n    npm run import:rules -- \"/path/to/CLASS A RULES.csv\"\n");
  process.exit(1);
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

let failed = false;

try {
  const { rules, notes, problems } = parseClassARules(readFileSync(path, "utf8"));

  console.log(`\nCLASS A RULES — ${path.split("/").pop()}\n`);
  console.log(`  read:     ${rules.length} rules`);
  console.log(`  live:     ${rules.filter((r) => r.status === "live").length}`);
  console.log(`  retired:  ${rules.filter((r) => r.status === "retired").length}`);
  console.log(`  critical: ${rules.filter((r) => r.status === "live" && r.severity === "critical").length}`);

  if (problems.length) {
    // Loudly, and before writing anything. A rule that could not be read is a
    // rule the bot will not be told about, and silence here is how that
    // becomes somebody's surprise in a month.
    console.log(`\n  ${problems.length} PROBLEM(S) — these rows were NOT imported:`);
    for (const p of problems) console.log(`    line ${p.row}: ${p.why}`);
  }
  if (!rules.length) throw new Error("nothing usable in that file");

  // Rules first: the notes table references them.
  const { error: rErr } = await sb.from("sms_class_a_rules").upsert(
    rules.map((r) => ({
      code: r.code,
      statement: r.statement,
      rule_card: r.ruleCard,
      corrective_action: r.correctiveAction,
      severity: r.severity,
      status: r.status,
      phrasing_only: r.phrasingOnly,
      binds: r.binds,
      source: r.source,
      measured_breaches: r.measuredBreaches,
      change_type: r.changeType,
      last_modified: r.lastModified,
      last_re_rated: r.lastReRated,
      updated_at: new Date().toISOString(),
    })),
    { onConflict: "code" }
  );
  if (rErr) throw new Error(`writing rules: ${rErr.message}`);

  const { error: nErr } = await sb.from("sms_class_a_rule_notes").upsert(
    notes.map((n) => ({
      code: n.code,
      rating_guidance: n.ratingGuidance,
      history: n.history,
      updated_at: new Date().toISOString(),
    })),
    { onConflict: "code" }
  );
  if (nErr) throw new Error(`writing rater notes: ${nErr.message}`);

  console.log(`\n  ✓ written`);

  /* ── Read it back, and check the separation actually held ──────────── */
  const { data: back, error: bErr } = await sb.from("sms_class_a_rules").select("*");
  if (bErr) throw new Error(`reading back: ${bErr.message}`);
  console.log(`  ✓ ${back.length} rules in sms_class_a_rules`);

  // SELECT * on the bot-facing table, checked for the text that must never
  // reach a model. This is the property the two-table split exists to give,
  // so it is worth proving against the real rows rather than assuming.
  const serialised = JSON.stringify(back);
  const leaked = notes
    .map((n) => n.ratingGuidance)
    .filter(Boolean)
    .flatMap((g) => g.split(/[.\n]/).map((s) => s.trim()))
    .filter((s) => s.length > 40)
    .filter((s) => serialised.includes(s));
  if (leaked.length) {
    failed = true;
    console.log(`  ✗ RATER-ONLY TEXT IS IN THE BOT-FACING TABLE: ${leaked[0].slice(0, 70)}…`);
  } else {
    console.log(`  ✓ no rater-only text in the bot-facing table`);
  }

  // What the model will actually be handed, built from the stored rows rather
  // than from the file — so the number is the real one.
  const stored = back.map((r) => ({
    code: r.code, statement: r.statement, ruleCard: r.rule_card,
    correctiveAction: r.corrective_action, severity: r.severity, status: r.status,
    phrasingOnly: r.phrasing_only, binds: r.binds, source: r.source,
    measuredBreaches: r.measured_breaches, changeType: r.change_type,
    lastModified: r.last_modified, lastReRated: r.last_re_rated,
  }));
  const prompt = forPrompt(stored);
  console.log(`  ✓ ${promptable(stored).length} rules would go in the prompt: ${prompt.length.toLocaleString()} chars (~${Math.round(prompt.length / 4).toLocaleString()} tokens per reply)`);

  console.log(`\n${failed ? "FAILURES" : "ALL GOOD"}\n`);
} catch (err) {
  failed = true;
  console.log(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
}

process.exit(failed ? 1 : 0);
