/**
 * AN ACTIVE WORKSPACE IN A STATE A2 REFUSES.
 *
 *   node --env-file=.env.local scripts/check-active-workspaces-are-serviced.mjs
 *
 * READ ONLY. Writes nothing.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────
 *
 * A2 step 1 is a hard gate: the state must be one of NJ, CA, CT, FL, NY, CO,
 * and a zip outside those is out_of_state whatever its record says. That
 * renders A2 script 2 — the only message in the system that tells a customer
 * no outright.
 *
 * The workspace table already holds TX Dallas Leads, AM - Dallas TX, TX Meta
 * 2, NC Leads and LA Baton Rouge Leads. All are inactive, so nothing is
 * wrong today. The trap is the ORDER OF OPERATIONS at expansion: switching
 * one of them on is a single field in the UI, a change somebody will
 * reasonably make without touching code, and from that moment every lead in
 * that workspace's own region is told PPP does not serve their state.
 *
 * Nothing would have caught that. Question 24 raised it as a tripwire for
 * whoever expands; this is the tripwire, so it fails loudly on the day
 * rather than being discovered from a customer's reply.
 *
 * ── WHAT TO DO IF IT FAILS ──────────────────────────────────────────────
 *
 * Add the state to SERVICED_STATES in lib/messaging/territory.ts AND give
 * the region real territory zips, in the same change that switches the
 * workspace on. The list and the map have to move together: the six states
 * and the live territories match exactly today, and that is the property
 * worth keeping.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

/**
 * Read from the source of truth rather than restated here. A second copy of
 * this list is exactly how it drifts — service-zip.ts says so in its own
 * comment, having been that second copy once.
 */
const src = readFileSync("lib/messaging/territory.ts", "utf8");
const m = /SERVICED_STATES = new Set\(\[([^\]]+)\]\)/.exec(src);
if (!m) {
  console.error("COULD NOT CHECK: SERVICED_STATES not found in territory.ts.");
  console.error("This is NOT a pass.");
  process.exit(2);
}
const serviced = new Set([...m[1].matchAll(/"([A-Z]{2})"/g)].map((x) => x[1]));

const { data: ws, error } = await sb.from("sms_sub_accounts")
  .select("name, is_active, phone_e164").order("name");
if (error) {
  console.error(`COULD NOT CHECK: ${error.message}`);
  console.error("This is NOT a pass.");
  process.exit(2);
}

/**
 * The state lives in the NAME, which is how these workspaces are organised:
 * "TX Dallas Leads", "NY LI Nassau Leads", "AM - SoFlo", "WC CT Meta".
 *
 * TWO WRONG VERSIONS BEFORE THIS ONE, both caught by running it:
 *
 *   taking the LEADING two-letter token made "AM - NJ" the state "AM" and
 *   "ZZ TEST" the state "ZZ" — four false positives on active workspaces.
 *
 *   accepting any two capitals made "WC CT Meta" the state "WC", reporting
 *   a Westchester workspace as outside the service area when its state is
 *   CT and CT is served.
 *
 * So it scans every token and takes the first that is a REAL state code. A
 * workspace named after a region falls through to the next token instead of
 * inventing a state, and a genuinely new state code is still caught.
 */
const stateOf = (name) => {
  const US_STATES = new Set([
    "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
    "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
    "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
    "VA","WA","WV","WI","WY","DC",
  ]);
  const notAState = (code) => !US_STATES.has(code);

  // "AM - NJ", "AM - Dallas TX", "AM - SoFlo"
  const am = /^AM\s*-\s*(.+)$/.exec(name);
  if (am) {
    const inner = am[1];
    for (const tok of inner.match(/\b[A-Z]{2}\b/g) ?? []) {
      if (!notAState(tok)) return tok;
    }
    // "AM - SoFlo" names a region, not a state. Nothing to check.
    return null;
  }

  for (const tok of name.match(/\b[A-Z]{2}\b/g) ?? []) {
    if (!notAState(tok)) return tok;
  }
  return null;
};

const active = (ws ?? []).filter((w) => w.is_active);
const offending = active
  .map((w) => ({ ...w, state: stateOf(w.name) }))
  .filter((w) => w.state && !serviced.has(w.state));

console.log(`\nSERVICED_STATES: ${[...serviced].join(", ")}`);
console.log(`active workspaces: ${active.length} of ${(ws ?? []).length}\n`);

if (offending.length) {
  console.log(`✗  ${offending.length} ACTIVE workspace(s) in a state A2 refuses:\n`);
  for (const w of offending) {
    console.log(`     ${w.name}  (${w.state})  ${w.phone_e164 ?? "no number"}`);
  }
  console.log(
    `\n   Every lead routed to these is told PPP does not serve their state —`
    + `\n   A2 script 2, the one message that turns a customer away outright.`
    + `\n`
    + `\n   Add the state to SERVICED_STATES in lib/messaging/territory.ts AND`
    + `\n   give the region real territory zips, in the same change that`
    + `\n   switched the workspace on. See question 24.\n`
  );
  process.exit(1);
}

const dormant = (ws ?? [])
  .filter((w) => !w.is_active)
  .map((w) => ({ ...w, state: stateOf(w.name) }))
  .filter((w) => w.state && !serviced.has(w.state));

console.log(`✓  every active workspace is in a state A2 serves.`);
if (dormant.length) {
  console.log(`\n   ${dormant.length} dormant workspace(s) are outside it, which is fine while`);
  console.log(`   they stay off — this check is what fails if one is switched on:`);
  for (const w of dormant) console.log(`     ${w.name}  (${w.state})`);
}
console.log("");
process.exit(0);
