/**
 * Every read of a table big enough to be silently truncated.
 *
 * ── THE BUG THIS EXISTS FOR ─────────────────────────────────────────────
 *
 * PostgREST caps an unbounded select at 1,000 rows and says nothing: no
 * error, no flag, just a shorter array than the table has. Code that counts
 * something then counts the first thousand of them, and the number on the
 * screen is wrong in a direction nobody can see.
 *
 * It has happened five times in this repo, each found by accident:
 *
 *   loadOptOutRates        the denominator of the opt-out rate
 *   loadRetrievalCorpus    the corpus the bot learns from, 1,000 of 1,294
 *   loadRuleOverview       every per-rule breach count
 *   the training panel     every stat, short by 294
 *   the grading screen     294 conversations simply not on the page
 *
 * Finding the sixth by accident is not a plan. This asks the database which
 * tables are big enough to be at risk, then reads the source for anything
 * that touches one of them without bounding the read.
 *
 * Deliberately noisy in the safe direction: it would rather flag a read that
 * turns out to be fine than stay quiet about one that is not. Every
 * exemption is written down below with a reason.
 */
import { createClient } from "@supabase/supabase-js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

/**
 * How close to the cap a table has to be before its reads matter.
 *
 * Not 1,000. A table at 900 rows today is a table that truncates next month,
 * and the whole point is to hear about it before somebody reads a short
 * answer off a screen.
 */
const AT_RISK = 700;

/** The messaging tables. Others are somebody else's surface. */
const TABLES = [
  "sms_training_examples", "sms_example_findings", "sms_messages",
  "sms_conversations", "sms_class_a_rules", "sms_class_a_rule_notes",
  "sms_class_a_rule_changes", "sms_training_example_tags", "sms_opt_outs",
  "sms_scheduled_actions", "sms_drafts", "sms_campaign_steps",
];

/**
 * A read is bounded when any of these appear near it.
 *
 * selectAll pages. limit/range bound it explicitly. single/maybeSingle want
 * one row. eq on a primary key wants one row. in() is bounded by the list the
 * caller already holds. count/head asks the database to do the counting, which
 * is the correct answer to "how many" and is never truncated.
 */
const BOUNDED = [
  "selectAll", ".limit(", ".range(", ".maybeSingle()", ".single()",
  "count:", "head: true", ".in(",
];

/** Reads that are bounded for a reason a pattern cannot see. */
const EXEMPT = [
  // Writes. An insert or delete returning rows is not a read of the table.
  ".insert(", ".update(", ".delete(", ".upsert(",
];

const sources = [];
const walk = (dir) => {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx|mjs)$/.test(e) && !p.includes("__tests__")) sources.push(p);
  }
};
for (const root of ["lib", "app", "scripts"]) { try { walk(root); } catch {} }

console.log("\nTRUNCATION SWEEP — reads of tables near the 1,000-row cap\n");

const sizes = new Map();
for (const t of TABLES) {
  const { count, error } = await sb.from(t).select("*", { count: "exact", head: true });
  if (!error) sizes.set(t, count ?? 0);
}

const big = [...sizes.entries()].filter(([, n]) => n >= AT_RISK);
if (!big.length) {
  console.log(`  no table is within reach of the cap yet (largest is ${Math.max(...sizes.values())})`);
  console.log("\nALL CLEAR\n");
  process.exit(0);
}
for (const [t, n] of big) console.log(`  at risk: ${t} — ${n} rows`);
console.log();

let flagged = 0;
for (const file of sources) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (const [t] of big) {
    let idx = -1;
    while ((idx = text.indexOf(`from("${t}")`, idx + 1)) !== -1) {
      const lineNo = text.slice(0, idx).split("\n").length;
      // The statement, not the line: these chains wrap across several lines.
      const window = lines.slice(lineNo - 3, lineNo + 6).join("\n");
      if (!window.includes(".select(")) continue;
      if (EXEMPT.some((e) => window.includes(e))) continue;
      if (BOUNDED.some((b) => window.includes(b))) continue;
      flagged++;
      console.log(`  ✗ ${file}:${lineNo} reads ${t} without bounding it`);
      console.log(`      ${lines[lineNo - 1].trim().slice(0, 96)}`);
    }
  }
}

console.log(
  flagged
    ? `\nFAILURES — ${flagged} read(s) can be silently truncated\n`
    : `\n  every read of those tables is paged, bounded, or counted by the database\n\nALL CLEAR\n`
);
process.exit(flagged ? 1 : 0);
