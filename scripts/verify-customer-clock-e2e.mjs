/**
 * WHOSE CLOCK DOES EACH LIVE CONVERSATION RESOLVE TO?
 *
 *   npm run verify:clock
 *
 * READ ONLY. It writes nothing, sends nothing and creates nothing. Every
 * figure comes from the function the gate itself calls.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM THE UNIT TESTS ──────────────────────
 *
 * The unit tests prove the RULE. They cannot prove the rule is reached,
 * because they supply their own state. `customerState` is a dep with four
 * call sites and no test that runs it against a real row — which is precisely
 * the shape of every "logic written, consumer never wired" bug in this
 * codebase, A7 included, where a live critical rule never once fired.
 *
 * So this walks the real conversations and reports, per conversation, which
 * zone the gate would use and WHERE that answer came from. A resolution that
 * silently fell through to the fallback for all ten is a working function and
 * a useless one, and only this can tell the difference.
 *
 * It FAILS rather than passes when it measures nothing.
 */
import { createClient } from "@supabase/supabase-js";
import { selectAll } from "../lib/messaging/paging.ts";
import { gateDeps } from "../lib/messaging/gate-deps.ts";
import { customerZone, zoneForState } from "../lib/messaging/customer-clock.ts";
import { sendingWindow } from "../lib/messaging/sending-window.ts";
import { FEDERAL_BOUND, withinQuietHours } from "../lib/messaging/compliance.ts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});
const deps = gateDeps(sb);

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓  ${label}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  ✗  ${label}${extra ? "  " + extra : ""}`); }
};

console.log("\nWHOSE CLOCK — every live conversation\n");

// PAGED, and ordered by something UNIQUE. An unbounded select is silently
// capped at 1,000 rows by PostgREST, and a range without a stable sort
// returns an arbitrary window rather than the rows the last page missed.
// The repo's own static check caught this file doing both.
const convs = await selectAll(
  (from, to) => sb
    .from("sms_conversations")
    .select("id, customer_phone, customer_zip, customer_address, workspace_id")
    .order("id")
    .range(from, to),
  "sms_conversations"
);

ok("measured something: conversations", convs.length >= 1, `${convs.length}`);

const bySource = { zip: 0, area_code: 0, fallback: 0 };
const zones = new Set();

for (const c of convs) {
  const state = await deps.customerState(c.customer_phone);
  const zone = customerZone({ zipState: state, phone: c.customer_phone });
  bySource[zone.source]++;
  zones.add(zone.timeZone);
  const addr = (c.customer_address ?? "").replace(/\s+/g, " ").slice(0, 34);
  console.log(
    `     ${c.customer_phone.padEnd(13)} ${(state ?? "--").padEnd(3)} ` +
    `${zone.timeZone.padEnd(20)} ${zone.source.padEnd(10)} ${addr}`
  );
}

console.log("");
ok("every conversation resolved to SOME zone", bySource.zip + bySource.area_code + bySource.fallback === convs.length);

/**
 * CAN THE DATA SUPPORT AN ANSWER AT ALL?
 *
 * Asked before the resolver is judged, because the first run of this check
 * failed for a reason that had nothing to do with the resolver: every live
 * conversation carries a number like +15550152 — seven national digits, not
 * ten. They are seed rows. A number that shape cannot be placed, and cannot
 * be texted either, so the fallback was the correct answer and a red line
 * here would have sent somebody looking for a bug in working code.
 *
 * Reported rather than skipped, because "none of our conversations has a
 * real phone number" is worth somebody knowing.
 */
const placeable = convs.filter((c) => {
  const d = (c.customer_phone ?? "").replace(/\D/g, "");
  const national = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return national.length === 10;
});
console.log(`  i  ${placeable.length} of ${convs.length} conversations carry a well-formed 10-digit number`);

if (placeable.length === 0) {
  console.log(`  –  so the resolver is UNPROVEN against live data. Every row is seed data`);
  console.log(`     with a short number; the fallback is the right answer for all ten.`);
  console.log(`     This turns into a real check the moment one real conversation exists.`);
} else {
  /**
   * THE POINT OF THE WHOLE EXERCISE. If every placeable conversation still
   * lands on the fallback, the resolver is running and telling us nothing,
   * and the gate is holding every customer to Pacific hours. Safe, wrong, and
   * indistinguishable from success on a pass/fail line.
   */
  ok("the resolver is actually resolving, not just falling back",
     bySource.fallback < convs.length,
     `zip ${bySource.zip} · area code ${bySource.area_code} · fallback ${bySource.fallback}`);
  ok("it does not put every customer on one clock",
     zones.size >= 2, `${zones.size} distinct zones: ${[...zones].join(", ")}`);
}

/**
 * AND SEPARATELY: PROVE THE RESOLVER IS NOT INERT.
 *
 * The block above can go quiet when the data is thin. This one cannot — it
 * runs the same function the gate calls against numbers whose answer is
 * known, so "the resolver works" is never left resting on rows that happen
 * to exist today.
 */
for (const [phone, wantZone, wantSource] of [
  ["+16195550147", "America/Los_Angeles", "area_code"],
  ["+15165550147", "America/New_York", "area_code"],
  ["+13035550147", "America/Denver", "area_code"],
  ["+12145550147", "America/Chicago", "area_code"],
  ["+19995550147", "America/Los_Angeles", "fallback"],
]) {
  const z = customerZone({ phone });
  ok(`${phone} resolves to ${wantZone} by ${wantSource}`,
     z.timeZone === wantZone && z.source === wantSource,
     `got ${z.timeZone} by ${z.source}`);
}

/* ── The rail: no resolution may ever permit a send outside 8am-9pm ───── */

/**
 * Swept across a whole day rather than argued about. For every conversation
 * and every half hour of a week, if the window says open then the FEDERAL
 * bound must hold on that customer's own clock. This is the property that
 * matters legally, and it is checked against the resolver's real answers
 * rather than against zones I chose.
 */
let openCount = 0, violations = 0;
const start = new Date("2026-09-28T00:00:00Z");

/**
 * Every zone PPP's territory table reaches, not only the ones today's rows
 * happen to resolve to. The first version of this swept the conversations
 * alone — and since all ten fall back to Pacific, it proved the rail holds in
 * ONE zone and read as if it had proved it everywhere.
 */
// 2,191 rows — over the 1,000 cap, so the first version of this built its
// zone list from a truncated read and found four zones by luck rather than
// by measurement. Exactly the fault this script exists to catch elsewhere.
const states = await selectAll(
  (from, to) => sb.from("sms_service_zips").select("state").order("zip").range(from, to),
  "sms_service_zips"
);
const servedZones = new Set(states.map((r) => zoneForState(r.state)).filter(Boolean));
console.log(`  i  ${states.length} territory zips read (paged; an unbounded select stops at 1,000)`);
for (const c of convs) {
  const state = await deps.customerState(c.customer_phone);
  const zone = customerZone({ zipState: state, phone: c.customer_phone });
  servedZones.add(zone.timeZone);
}
ok("measured something: zones PPP actually serves", servedZones.size >= 3,
   `${servedZones.size}: ${[...servedZones].join(", ")}`);

for (const customerTz of servedZones) {
  const zone = { timeZone: customerTz };
  for (let i = 0; i < 7 * 48; i++) {
    const now = new Date(start.getTime() + i * 30 * 60_000);
    for (const answersInbound of [false, true]) {
      const w = sendingWindow({
        now, customerZone: zone.timeZone,
        officeZone: "America/New_York", answersInbound,
      });
      if (!w.open) continue;
      openCount++;
      if (!withinQuietHours(now, zone.timeZone, { ...FEDERAL_BOUND })) {
        violations++;
        if (violations <= 5) {
          console.log(`     ${now.toISOString()} inbound=${answersInbound} zone=${zone.timeZone}`);
        }
      }
    }
  }
}

ok("measured something: instants the window called open", openCount >= 1, `${openCount}`);
ok("NOTHING the window permits falls outside the federal 8am-9pm on the customer's clock",
   violations === 0, `${violations} violations across ${openCount} permitted instants`);

/* ── Is the scheduler actually alive? ─────────────────────────────────── */

/**
 * EVERY RULE ABOVE IS MOOT IF THE TICK NEVER RUNS.
 *
 * A44's cadence, held replies and campaign steps all reach the customer
 * through /api/cron/messaging-tick. With no active campaigns the queue stays
 * empty whether that fires every minute or never fires at all — so on
 * 2026-09-26 nothing in the database could tell the two apart, and I gave
 * Karan the wrong answer twice before looking at Vercel's cron panel.
 *
 * The tick now writes a heartbeat on EVERY run, including the empty ones.
 * Reported rather than failed: a stale heartbeat on a local run just means
 * production has not ticked since the last deploy, which is not a defect in
 * the code this script is checking.
 */
try {
  const { data: hb } = await sb.from("commercial_settings")
    .select("value").eq("key", "messaging_tick_last_run").maybeSingle();
  const at = hb?.value?.at ?? null;
  if (!at) {
    console.log(`  –  the messaging tick has NOT written a heartbeat yet. Either it has not run since the heartbeat shipped, or it is not running at all — check Vercel's Cron Jobs panel, which is the other place that answers this.`);
  } else {
    const mins = Math.round((Date.now() - Date.parse(at)) / 60000);
    const fresh = mins <= 10;
    console.log(`  ${fresh ? "✓" : "i"}  messaging tick last ran ${mins} min ago${fresh ? "" : " — stale; it runs every minute in production, so anything over ~10 min means it is not firing"}`);
  }
} catch (e) {
  console.log(`  –  could not read the tick heartbeat: ${e.message.slice(0, 80)}`);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass + fail} checks\n`);
process.exit(fail === 0 ? 0 : 1);
