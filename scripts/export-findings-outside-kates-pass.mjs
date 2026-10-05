/**
 * WHICH FINDINGS ARE OURS AND NOT HERS?
 *
 *   node --import ./scripts/ts-resolve.mjs scripts/export-findings-outside-kates-pass.mjs
 *
 * READ ONLY. Writes one CSV to the current directory and touches nothing else.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────
 *
 * Kate's spec names A13's baseline as 192 defects and 77 good turns. The Rule
 * Hub shows 206/107, and the gap had been written up as a suspected
 * over-counting importer. It is not: the table holds three rating sittings,
 * and hers is one of them.
 *
 *   2026-09-15     14 defects    30 done well
 *   2026-09-24    192 defects    77 done well     <- Kate's pass, the spec's number
 *   2026-09-26      1 defect      0
 *
 * 192 + 14 + 1 = 207 and 77 + 30 = 107. Nothing is miscounted.
 *
 * Kate, 2026-10-05: "Is it possible to see which ones you've rated that were
 * not rated on my side? I'm assuming the extras were properly rated with the
 * new rulings."
 *
 * That is a fair question and the honest answer needs the rows, not a count:
 * the earlier sitting predates several rulings she has since made, so some of
 * those findings may have been graded against rules that have changed. This
 * exports them with the turn text so she can read them rather than take our
 * word for it.
 *
 * ── THE DATE IS THE AXIS, AND IT TOOK TWO GOES TO SEE THAT ──────────────
 *
 * An earlier attempt filtered on `source = 'hatch'`, reasoning that the gap
 * was corpus versus all-time. That gives 206/107 and explains nothing. The
 * axis is created_at.
 */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

/** The day Kate rated. Everything else is what she is asking to see. */
const KATES_PASS = "2026-09-24";

const page = async (table, select) => {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(select).order("id").range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
};

const findings = await page("sms_example_findings",
  "id, example_id, code, kind, severity, what, should_have, created_at, turn_text, turn_label");
const examples = await page("sms_training_examples", "id, source, outcome, graded_by");
const byId = new Map(examples.map((e) => [e.id, e]));

const day = (f) => (f.created_at ?? "").slice(0, 10);
const outside = findings.filter((f) => day(f) !== KATES_PASS);

console.log(`\n${findings.length} findings in total · ${findings.length - outside.length} from Kate's ${KATES_PASS} pass · ${outside.length} from other days\n`);

const byDay = {};
for (const f of outside) {
  const d = day(f) || "(no date)";
  byDay[d] ??= { defects: 0, didWell: 0, codes: new Set() };
  if (f.kind === "did_well") byDay[d].didWell++; else byDay[d].defects++;
  byDay[d].codes.add(f.code ?? "(no rule code)");
}
console.log("by day:");
for (const [d, c] of Object.entries(byDay).sort()) {
  console.log(`  ${d}   ${String(c.defects).padStart(4)} defects  ${String(c.didWell).padStart(4)} done well   rules: ${[...c.codes].sort().join(" ")}`);
}

/**
 * AND THE QUESTION UNDER HER QUESTION.
 *
 * She wrote "I'm assuming the extras were properly rated with the new
 * rulings." That is the thing worth checking, and it is checkable: compare
 * when each finding was recorded against when its rule was last modified.
 */
// Not via page(): that orders by id, and this table is keyed by code.
const { data: rules, error: rulesErr } = await sb.from("sms_class_a_rules")
  .select("code, last_modified, change_type");
if (rulesErr) throw new Error(`sms_class_a_rules: ${rulesErr.message}`);
const ruleBy = new Map((rules ?? []).map((r) => [r.code, r]));
let stale = 0, current = 0, unknown = 0;
const staleByRule = {};
for (const f of outside) {
  const r = f.code ? ruleBy.get(f.code) : null;
  if (!r?.last_modified) { unknown++; continue; }
  if (r.last_modified.slice(0, 10) > day(f)) {
    stale++;
    staleByRule[f.code] ??= { n: 0, when: r.last_modified.slice(0, 10), type: r.change_type ?? "no type" };
    staleByRule[f.code].n++;
  } else current++;
}
console.log(`\nrated BEFORE their rule was last changed : ${stale}`);
console.log(`rated after their rule was last changed  : ${current}`);
console.log(`no rule code, or no date on the rule     : ${unknown}`);
if (stale) {
  console.log("\nrules whose text moved after the finding was recorded:");
  for (const [code, v] of Object.entries(staleByRule).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${code.padEnd(5)} ${String(v.n).padStart(3)}   rule last modified ${v.when} (${v.type})`);
  }
}

/** Excel-safe: quote everything, double the quotes, keep newlines inside cells. */
const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const header = ["rated_on", "rule", "kind", "severity", "turn_label", "turn_text", "what_was_wrong", "should_have", "example_source", "example_outcome", "graded_by", "example_id", "rule_last_modified", "stale"];
const lines = [header.map(cell).join(",")];
const sorted = outside.slice().sort((a, b) =>
  (a.created_at ?? "").localeCompare(b.created_at ?? "") || (a.code ?? "").localeCompare(b.code ?? ""));
for (const f of sorted) {
  const e = byId.get(f.example_id) ?? {};
  lines.push([
    day(f), f.code, f.kind, f.severity, f.turn_label, f.turn_text,
    f.what, f.should_have, e.source, e.outcome, e.graded_by, f.example_id,
    (f.code && ruleBy.get(f.code)?.last_modified || "").slice(0, 10),
    (f.code && ruleBy.get(f.code)?.last_modified || "").slice(0, 10) > day(f) ? "RULE CHANGED SINCE" : "",
  ].map(cell).join(","));
}

const out = "findings-outside-kates-pass.csv";
writeFileSync(out, lines.join("\n"), "utf8");
console.log(`\nwrote ${out} — ${outside.length} rows, one per finding, with the turn text so each can be read on its own.`);
console.log("Nothing was modified.\n");
