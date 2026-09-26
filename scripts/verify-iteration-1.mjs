/**
 * THE ITERATION 1 SPEC, CHECKED AGAINST ITS OWN ACCEPTANCE CRITERIA.
 *
 *   npm run verify:iteration-1
 *
 * READ ONLY. Sends nothing, writes nothing, creates nothing.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM 5,400 UNIT TESTS ────────────────────
 *
 * The suite tests what we decided to build. This tests what the SPEC ASKED
 * FOR, in its own words, using the "DONE WHEN" line from each of the eleven
 * capability cards plus the two internal builds. They are not the same thing:
 * a capability can be fully tested and still not be what was asked for, and
 * four defects today survived the whole suite because the suite was asserting
 * our reading rather than the requirement.
 *
 * Every check below quotes the criterion it is checking. If a quote and the
 * code disagree, the code is wrong.
 */
import { createClient } from "@supabase/supabase-js";

import { sendingWindow } from "../lib/messaging/sending-window.ts";
import { customerZone } from "../lib/messaging/customer-clock.ts";
import {
  DISCLOSURE_IN_HOURS, DISCLOSURE_OUT_OF_HOURS, disclosureMove, applyDisclosure,
} from "../lib/messaging/disclosure.ts";
import { renderMessage, isSilent } from "../lib/messaging/render.ts";
import { END_INTENTS, CONTINUE_INTENTS, validateAction } from "../lib/messaging/agent-output.ts";
import { parkReopenAt } from "../lib/messaging/park-time.ts";
import { followUpSchedule, FOLLOW_UP_HOURS } from "../lib/messaging/stalled.ts";
import { pauseOnReply, resumeAfterCadence } from "../lib/messaging/call-signals.ts";
import { phoneBranch, statedChannelPreference } from "../lib/messaging/channel-preference.ts";
import { conversationLanguage } from "../lib/messaging/language.ts";
import { normalizeInbound } from "../lib/messaging/inbound-normalize.ts";
import { buildRaterPrompt } from "../lib/messaging/rater.ts";
import { forPrompt } from "../lib/messaging/class-a-rules.ts";
import { replyToRequestedTime } from "../lib/messaging/appointment-time.ts";

/** The detail view's own loader, so the check asks what the screen asks. */
async function loadRuleDetailAll(codes) {
  const { loadRuleDetail } = await import("../lib/messaging/rules-db.ts");
  const out = [];
  for (const c of codes) {
    const d = await loadRuleDetail(c);
    if (d) out.push(d);
  }
  return out;
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

let pass = 0, fail = 0;
const ok = (criterion, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓  ${criterion}${detail ? `  — ${detail}` : ""}`); }
  else { fail++; console.log(`  ✗  ${criterion}${detail ? `\n       ${detail}` : ""}`); }
};
const head = (n, name) => console.log(`\n${n}. ${name}`);

const NY = "America/New_York", LA = "America/Los_Angeles";
const hourIn = (d, tz) => Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(d)) % 24;

console.log("\nITERATION 1 — every DONE WHEN, in the spec's own words\n" + "=".repeat(68));

/* ── 1. Conversation memory ─────────────────────────────────────────── */
head(1, "Conversation memory");
// "No field the bot already holds is asked for twice."
const heldAddress = validateAction(
  { intent: "ask_address", confidence: 0.9 },
  { knownFields: { address: true } }
);
/**
 * Asserts the REASON, not just the refusal. The first version checked only
 * `ok === false`, which would have passed just as happily if the action had
 * been rejected for a malformed shape — a pass for the wrong reason, which is
 * the failure mode this whole file exists to avoid.
 */
ok('"No field the bot already holds is asked for twice"',
   heldAddress.ok === false && /already on file/i.test(heldAddress.detail ?? ""),
   heldAddress.ok ? "ask_address was ALLOWED with an address on file" : `refused: ${heldAddress.detail}`);

/* ── 2. Business hours ──────────────────────────────────────────────── */
head(2, "Business hours");
// "Tested at 7:30 PM Eastern with a California lead and an Eastern lead: on
//  the same clock tick, one gets the in-hours behaviour and the other gets
//  the prefix."
const tick = new Date("2026-09-28T23:30:00Z");   // Monday 7:30pm ET
const east = sendingWindow({ now: tick, customerZone: NY });
const west = sendingWindow({ now: tick, customerZone: LA });
ok('7:30 PM ET: the CA lead is in hours and the ET lead is not, same tick',
   west.open === true && east.open === false,
   `CA ${west.open ? "in hours" : "out"} · ET ${east.open ? "in hours" : "out"}`);
// "the callback window is open on Sunday, 9 AM to 5:30 PM… Sunday daytime is
//  in hours for messaging."
const sunday = new Date("2026-10-04T16:00:00Z");  // Sun 12pm ET
ok('Sunday daytime is in hours for messaging',
   sendingWindow({ now: sunday, customerZone: NY }).open === true);
// "Never call a Pacific or Mountain customer before 9 AM THEIR local time."
const earlyPacific = new Date("2026-09-28T13:30:00Z");   // 6:30am PT
ok('never before 9 AM on a Pacific customer\'s own clock',
   sendingWindow({ now: earlyPacific, customerZone: LA }).open === false);

/* ── 3. AI disclosure ───────────────────────────────────────────────── */
head(3, "AI disclosure (A46)");
ok('both strings byte-for-byte',
   DISCLOSURE_IN_HOURS === "I'm an AI assistant, but I can take your project details and get you set up with an estimator. Would you prefer to speak with a member of our team?"
   && DISCLOSURE_OUT_OF_HOURS === "I'm an AI assistant, but I can take your project details and pass them along once we open.");
ok('"Nothing in the opener announces the bot during business hours"',
   disclosureMove({ askedIfBot: false, outOfHours: false, alreadyDisclosed: false }) === null);
ok('"the prefix goes on the first reply… not on every message"',
   disclosureMove({ askedIfBot: false, outOfHours: true, alreadyDisclosed: false }) === "prefix"
   && disclosureMove({ askedIfBot: false, outOfHours: true, alreadyDisclosed: true }) === null);
ok('"the question is not an ending"',
   [...CONTINUE_INTENTS].includes("bot_suspected") && ![...END_INTENTS].includes("bot_suspected"));
ok('"The bot never denies being a bot, in any state"',
   !/real person/i.test(applyDisclosure("answer", "")) && /AI assistant/.test(applyDisclosure("answer", "")));

/* ── 4. Human takeover ──────────────────────────────────────────────── */
head(4, "Human takeover");
// "The bot sends nothing on the way out — no sign-off, no handover line."
ok('"The bot sends nothing on the way out"',
   renderMessage({ intent: "escalate", turn: 0 }) === "" && isSilent({ intent: "escalate" }) === true);

/* ── 5. Parking ─────────────────────────────────────────────────────── */
head(5, "Parking (A40)");
const today = { year: 2026, month: 9, day: 24 };
const now = new Date("2026-09-24T14:00:00Z");
const named = parkReopenAt({ text: "get back to me after the 15th", today, customerZone: NY, notBefore: now });
ok('"The bot re-opens the thread itself, at the time the customer named"',
   named !== null && named.getTime() > now.getTime(),
   named ? `${named.toISOString()} (${hourIn(named, NY)}:00 their clock)` : "no reminder set");
// "Often the customer names no time at all… do not infer one."
ok('no time named -> no reminder is invented',
   parkReopenAt({ text: "once I've spoken to my wife", today, customerZone: NY, notBefore: now }) === null);

/* ── 6. Stalled conversations ───────────────────────────────────────── */
head(6, "Stalled conversations (A44)");
const sched = followUpSchedule({ from: new Date("2026-09-28T20:00:00Z"), customerZone: NY, notBefore: now });
ok('"Three follow-ups go out at 10 AM / 3 PM / 6 PM the customer\'s local time"',
   sched.length === 3 && JSON.stringify(sched.map((d) => hourIn(d, NY))) === JSON.stringify([...FOLLOW_UP_HOURS]),
   sched.map((d) => `${hourIn(d, NY)}:00`).join(", "));
// "A36's outbound hours beat the 10/3/6 pattern… The third follow-up landing
//  EARLIER for Pacific and Mountain customers is correct, not a gap."
const pac = followUpSchedule({ from: new Date("2026-09-28T20:00:00Z"), customerZone: LA, notBefore: now });
ok('A36 beats the pattern: the Pacific third lands earlier, not next day',
   pac.length === 3 && hourIn(pac[2], LA) < 18,
   pac.map((d) => `${hourIn(d, LA)}:00`).join(", "));
ok('nothing is ever scheduled outside the window',
   [...sched, ...pac].every((d, i) => sendingWindow({ now: d, customerZone: i < 3 ? NY : LA }).open));

/* ── 7. Pause and resume calling ────────────────────────────────────── */
head(7, "Pause and resume calling (A45)");
const p1 = pauseOnReply({ conversationId: "c", leadId: null, alreadyPaused: false, customerReplied: true });
const p2 = pauseOnReply({ conversationId: "c", leadId: null, alreadyPaused: true, customerReplied: true });
ok('"One pause signal per conversation, not one per reply"', p1 !== null && p2 === null);
ok('"The resume signal fires only at the end of A44\'s cadence, and only where the customer was never reached"',
   resumeAfterCadence({ conversationId: "c", leadId: null, cadenceSpent: true, everReplied: false, alreadyResumed: false }) !== null
   && resumeAfterCadence({ conversationId: "c", leadId: null, cadenceSpent: false, everReplied: false, alreadyResumed: false }) === null
   && resumeAfterCadence({ conversationId: "c", leadId: null, cadenceSpent: true, everReplied: true, alreadyResumed: false }) === null);

/* ── 8. Communication preference ────────────────────────────────────── */
head(8, "Communication preference (A25)");
ok('a text-only preference is NOT a hand-off (ending is the defect)',
   statedChannelPreference("text only please, don't call") === "text_only");
ok('"On the phone branch it captures a callback time before handing off"',
   phoneBranch({}) === "ask_callback_time" && phoneBranch({ availability: "mornings" }) === "hand_to_human");
ok('a quote by text is A7, not a channel preference',
   statedChannelPreference("can you just text me the quote") === null);

/* ── 9. Photos ──────────────────────────────────────────────────────── */
head(9, "Photos (A26)");
const withPhoto = renderMessage({ intent: "acknowledge", turn: 0, photos: 2 });
ok('"The bot knows an image arrived and how many, names it in one short line"',
   /photo/i.test(withPhoto), JSON.stringify(withPhoto));
ok('"No reply ever prices or quotes from an image"',
   !/\$|\bprice\b|\bcost\b|\bquote\b/i.test(withPhoto));

/* ── 10. Message reactions ──────────────────────────────────────────── */
head(10, "Message reactions");
const quoted = normalizeInbound('Liked "What is your address?"');
ok('"A reaction arrives as a structured signal… never as text"',
   quoted.kind === "reaction" && quoted.text === null,
   "Hatch quoted our own text back and the bot answered itself");
ok('a thumbs-down is carried as negative', normalizeInbound('Disliked "ok?"').reaction?.sentiment === "negative");

/* ── 11. Language ───────────────────────────────────────────────────── */
head(11, "Language (A30)");
ok('"A two-word signal is enough to switch" — the spec\'s own trigger',
   conversationLanguage(["Sábado 9:30 am"]) === "es");
ok('"Every later turn stays in that language"',
   conversationLanguage(["Sábado 9:30 am", "ok", "sure"]) === "es");

/* ── Parity: a requested time is held, never confirmed ──────────────── */
head("+", "Hatch parity — a requested time (not in the spec, but customer-facing)");
const held = replyToRequestedTime("can you do Tuesday at 2?");
ok('a requested time is held, never confirmed',
   held?.reply === "I'll check the calendar for that time.");
ok('a house number is not a time',
   replyToRequestedTime("4821 Oak Lane") === null);

/* ── 12 + 13. The two internal builds ───────────────────────────────── */
head(12, "Rule Hub");
const { data: rules } = await sb.from("sms_class_a_rules").select("code, status, last_modified, change_type");
const live = (rules ?? []).filter((r) => r.status === "live");
const retired = (rules ?? []).filter((r) => r.status !== "live");
ok('"All 37 live rules are listed and the 9 retired ones are not"',
   live.length === 37 && retired.length === 9, `${live.length} live · ${retired.length} retired`);
/**
 * "Render both the date and the change type, or neither."
 *
 * A RENDERING criterion, so it is checked against what the SCREEN produces,
 * not against what the table holds. The first version of this check read the
 * table and stayed red after the fix, because the fix was in the mapper the
 * screen calls — it was asking a different question from the one the spec
 * asks.
 *
 * Kate's export carries the disagreement: A28 and A38 have a last_modified
 * of 2026-09-11 and no change_type. The mapper drops both halves together,
 * which is the "or neither" the criterion allows. Logged for her as a data
 * fix, since a date with no change type cannot say whether a batch went
 * stale.
 */
const rawHalf = live.filter((r) => Boolean(r.last_modified) !== Boolean(r.change_type));
const detail = await loadRuleDetailAll(rawHalf.map((r) => r.code));
const renderedHalf = detail.filter((d) => Boolean(d.lastModified) !== Boolean(d.changeType));
ok('"Render both the date and the change type, or neither"',
   renderedHalf.length === 0,
   `${renderedHalf.length} rendered half-stamped (${rawHalf.length} are half-stamped in Kate's export: ${rawHalf.map((r) => r.code).join(", ") || "none"})`);
if (rawHalf.length) {
  console.log(`     i  ${rawHalf.map((r) => r.code).join(", ")} carry a date with no change type in the export — the screen drops both, and it is logged for Kate`);
}

const findings = [];
for (let page = 0; ; page++) {
  const { data } = await sb.from("sms_example_findings")
    .select("code, kind, created_at").order("id").range(page * 1000, page * 1000 + 999);
  if (!data?.length) break;
  findings.push(...data);
  if (data.length < 1000) break;
}
const kate = findings.filter((f) => (f.created_at ?? "").startsWith("2026-09-24"));
const tally = (c) => ({
  d: kate.filter((f) => f.code === c && f.kind !== "did_well").length,
  g: kate.filter((f) => f.code === c && f.kind === "did_well").length,
});
const a13 = tally("A13");
ok('"A13 opens to 192 defects and 77 good turns"', a13.d === 192 && a13.g === 77, `${a13.d}/${a13.g}`);
const a35 = tally("A35");
ok('"A35 opens to zero of both and renders as a rule nothing has exercised"',
   a35.d === 0 && a35.g === 0);

head(13, "Auto-rater");
const GUIDE = "RATER ONLY PROBE — this string must never reach a bot prompt";
const probe = [{
  code: "A13", statement: "s", ruleCard: null, correctiveAction: null,
  severity: "critical", status: "live", phrasingOnly: false, binds: true,
  ratingGuidance: GUIDE,
}];
ok('"Rating guidance is read by the rater…"', buildRaterPrompt(probe).includes(GUIDE));
ok('"…and reaches no bot prompt, provably"', !forPrompt(probe).includes(GUIDE));

console.log("\n" + "=".repeat(68));
console.log(`${fail === 0 ? "EVERY ACCEPTANCE CRITERION MET" : `${fail} CRITERION(S) NOT MET`} — ${pass + fail} checked\n`);
process.exit(fail === 0 ? 0 : 1);
