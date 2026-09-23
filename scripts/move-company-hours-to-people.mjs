/**
 * ONE-OFF — move hours entered against a LABOR COMPANY onto the person.
 *
 * Run:
 *   node --env-file=.env.local scripts/move-company-hours-to-people.mjs
 *   node --env-file=.env.local scripts/move-company-hours-to-people.mjs --commit
 *
 * The import now folds a crew company onto the person Salesforce says it is,
 * so historical attendance already sits under the painter's own name. But
 * between go-live and that change, hours were entered ON THE PLATFORM against
 * the company names — because those were the names in the dropdown. Those rows
 * are real work somebody typed, not import artefacts, so they are moved rather
 * than removed.
 *
 * UPDATES ONLY. Nothing is deleted here:
 *
 *  · no clash → the row's employee_id is repointed at the person.
 *  · a clash (the person already has that job+date, which the unique index
 *    forbids duplicating) → the hours are SUMMED onto the person's row and the
 *    company's row is zeroed. Same arithmetic the import's own day-fold uses,
 *    and the platform total does not move. Ten of the eleven clashes are a
 *    person sitting at 0h while the company row carries the day, which is
 *    exactly what you would expect from the same day being logged under the
 *    name that was visible in the picker.
 *
 * ONE CASE IS LEFT ALONE, deliberately: JJ Lucatorto on 2026-09-17 has 8h
 * under his own name AND 8h under "Tomco Labor - JJ". That is either the same
 * day recorded twice or two men on one job, and the difference is a day's pay.
 * It is printed for Mary rather than guessed at.
 *
 * Afterwards, a company row left holding nothing is deactivated so it drops
 * out of the pickers — the roster stops showing the same man twice, which is
 * what Mary reported. Companies that are genuinely companies (Omar LI, LC RA
 * Jose, LC Ricardo, the generic "Tomco Labor", and "Tomco Labor - Keith", who
 * matches no painter on the roster) keep their hours and stay exactly as they
 * are.
 */
import { createClient } from "@supabase/supabase-js";

const COMMIT = process.argv.includes("--commit");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error("Run with --env-file=.env.local");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

/** Must match `crewCompanyWorker()` in import-tomco.mjs. */
const PAIRS = {
  "Tomco Labor - Greg": "Greg Stankewicz",
  "Tomco Labor - Miguel": "Miguel Melgar",
  "Tomco Labor - Rob": "Robert Caputo",
  "Tomco Labor - Joe": "Joseph Lucatorto",
  "Tomco Labor - JJ": "JJ Lucatorto",
  "Tomco Labor - Erick": "Erick Flores",
  "Tomco Labor - Carlos": "Carlos Rosconi",
  "Tomco Labor - Robert P": "Robert Patterson",
  "LC Alex Steve Wagner": "LC Alex Steve Wagner",
};

/** Needs a person's eye, not a rule. */
const LEAVE_ALONE = [{ person: "JJ Lucatorto", work_date: "2026-09-17" }];

const totalHours = async () => {
  let sum = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("commercial_time_entries")
      .select("actual_hours")
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const t of data ?? []) sum += Number(t.actual_hours ?? 0);
    if (!data || data.length < 1000) break;
  }
  return sum;
};

const before = await totalHours();
console.log(`total hours before: ${before.toFixed(2)}\n`);

const { data: emps, error: empErr } = await sb
  .from("commercial_employees")
  .select("id, display_name, external_ref, active");
if (empErr) throw new Error(empErr.message);
const companyByName = new Map(
  emps.filter((e) => (e.external_ref ?? "").startsWith("sf-crewco:")).map((e) => [e.display_name, e])
);
const personByName = new Map(
  emps.filter((e) => (e.external_ref ?? "").startsWith("sf-crew:")).map((e) => [e.display_name, e])
);

let moved = 0;
let summed = 0;
let held = 0;

for (const [coName, personName] of Object.entries(PAIRS)) {
  const co = companyByName.get(coName);
  const person = personByName.get(personName);
  if (!co || !person) {
    console.log(`skip ${coName}: ${!co ? "no company row" : `no person row for ${personName}`}`);
    continue;
  }

  const { data: rows, error } = await sb
    .from("commercial_time_entries")
    .select("id, job_id, work_date, actual_hours")
    .eq("employee_id", co.id);
  if (error) throw new Error(error.message);

  for (const r of rows ?? []) {
    const date = String(r.work_date).slice(0, 10);
    if (LEAVE_ALONE.some((x) => x.person === personName && x.work_date === date)) {
      held += 1;
      console.log(`HELD  ${personName} ${date}: ${r.actual_hours}h under ${coName} — needs Mary`);
      continue;
    }

    const { data: clash } = await sb
      .from("commercial_time_entries")
      .select("id, actual_hours")
      .eq("employee_id", person.id)
      .eq("job_id", r.job_id)
      .eq("work_date", r.work_date)
      .maybeSingle();

    if (!clash) {
      console.log(`MOVE  ${date} ${String(r.actual_hours).padStart(5)}h  ${coName} → ${personName}`);
      moved += 1;
      if (COMMIT) {
        const { error: e } = await sb
          .from("commercial_time_entries")
          .update({ employee_id: person.id })
          .eq("id", r.id);
        if (e) throw new Error(`move ${r.id}: ${e.message}`);
      }
      continue;
    }

    const total = Number(clash.actual_hours ?? 0) + Number(r.actual_hours ?? 0);
    console.log(
      `SUM   ${date} ${personName}: ${clash.actual_hours}h + ${r.actual_hours}h = ${total}h (company row zeroed)`
    );
    summed += 1;
    if (COMMIT) {
      const { error: e1 } = await sb
        .from("commercial_time_entries")
        .update({ actual_hours: total })
        .eq("id", clash.id);
      if (e1) throw new Error(`sum onto ${clash.id}: ${e1.message}`);
      const { error: e2 } = await sb
        .from("commercial_time_entries")
        .update({ actual_hours: 0 })
        .eq("id", r.id);
      if (e2) throw new Error(`zero ${r.id}: ${e2.message}`);
    }
  }
}

console.log(`\n${moved} moved, ${summed} summed, ${held} held for a person to decide`);

// Retire the company rows that now hold nothing at all.
if (COMMIT) {
  for (const coName of Object.keys(PAIRS)) {
    const co = companyByName.get(coName);
    if (!co) continue;
    const { data: left } = await sb
      .from("commercial_time_entries")
      .select("actual_hours")
      .eq("employee_id", co.id);
    const remaining = (left ?? []).reduce((s, t) => s + Number(t.actual_hours ?? 0), 0);
    if (remaining > 0) {
      console.log(`keep active: ${coName} still holds ${remaining}h`);
      continue;
    }
    const { error } = await sb.from("commercial_employees").update({ active: false }).eq("id", co.id);
    if (error) throw new Error(`deactivate ${coName}: ${error.message}`);
    console.log(`retired from the roster: ${coName}`);
  }
}

const after = COMMIT ? await totalHours() : before;
console.log(`\ntotal hours after:  ${after.toFixed(2)}`);
if (!COMMIT) {
  console.log("Dry run. Re-run with --commit to apply.");
} else {
  console.log(
    Math.abs(after - before) < 0.01
      ? "✅ not one hour moved in or out — only whose name it sits under changed."
      : `⚠️  the total CHANGED by ${(after - before).toFixed(2)}h — stop and look.`
  );
}
