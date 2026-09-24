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

/**
 * Tables that are at risk at ANY size, because they grow with the business.
 *
 * The row-count threshold above is reactive, and that is a real hole. Every
 * conversation adds a row to sms_conversations and every text adds one to
 * sms_messages, so both cross a thousand the same week the system carries
 * real volume — while a check that only looks at tables already over 700 says
 * ALL CLEAR the entire time somebody is writing the read that will break.
 *
 * bucketCounts was exactly that: an unbounded read of every conversation to
 * count the inbox chips, written and shipped while the table held ten rows.
 * It would have started under-reporting "Needs human" at conversation 1,001
 * and this sweep would not have mentioned it once beforehand.
 *
 * Correctness here cannot wait for the table to get big enough to notice.
 */
const ALWAYS_AT_RISK = ["sms_conversations", "sms_messages"];

/**
 * DISCOVERED, not listed — and this file had the same hand-written list the
 * PII sweep did, which was the whole flaw that sweep was rewritten to fix.
 * Fixing one and not its sibling is exactly the pattern these sweeps exist
 * to catch, so: 12 tables became 31.
 *
 * sf_lead_inbound was among the missing, at 639 rows and climbing. It is the
 * queue the lead poll reads.
 */
async function discoverTables() {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL + "/rest/v1/";
  const res = await fetch(base, {
    headers: { apikey: process.env.SUPABASE_SECRET_KEY, Authorization: "Bearer " + process.env.SUPABASE_SECRET_KEY },
  });
  if (!res.ok) throw new Error(`could not read the schema: ${res.status}`);
  const spec = await res.json();
  return Object.keys(spec.definitions ?? spec.components?.schemas ?? {})
    .filter((t) => /^(sms_|sf_)/.test(t)).sort();
}

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
  "count:", "head: true",
  // One conversation's own thread. A lead thread does not reach a thousand
  // messages, and max_turns stops the bot long before anything close to it.
  '.eq("conversation_id"',
];

/**
 * .in() IS NOT ON THAT LIST, and it used to be, described as "bounded by the
 * list the caller already holds".
 *
 * That is true of the filter and false of the result. Reading messages for
 * 1,500 live conversations returns every message in all of them — tens of
 * thousands of rows through a cap of one thousand — and the id list being
 * finite has nothing to do with it. The aging report did this: it paged the
 * conversations correctly and then truncated their messages, so the oldest
 * threads silently lost their last-reply times and aged wrongly.
 *
 * A second reason, unrelated and just as fatal: a .in() carrying thousands of
 * UUIDs is a request URL tens of kilobytes long. Chunk the ids, page each
 * chunk.
 */

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

const TABLES = await discoverTables();
const sizes = new Map();
for (const t of TABLES) {
  const { count, error } = await sb.from(t).select("*", { count: "exact", head: true });
  if (!error) sizes.set(t, count ?? 0);
}

const big = [...sizes.entries()].filter(
  ([t, n]) => n >= AT_RISK || ALWAYS_AT_RISK.includes(t)
);
if (!big.length) {
  console.log(`  no table is within reach of the cap yet (largest is ${Math.max(...sizes.values())})`);
  console.log("\nALL CLEAR\n");
  process.exit(0);
}
for (const [t, n] of big) {
  const why = n >= AT_RISK ? `${n} rows` : `${n} rows, but grows one per customer`;
  console.log(`  at risk: ${t} — ${why}`);
}
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
