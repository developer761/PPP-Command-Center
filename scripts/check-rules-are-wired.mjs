/**
 * IS THE RULE WIRED, OR ONLY WRITTEN?
 *
 *   node scripts/check-rules-are-wired.mjs
 *
 * READ ONLY. Reads source files and nothing else.
 *
 * ── THE FAILURE THIS EXISTS FOR ─────────────────────────────────────────
 *
 * The most expensive bug shape in this codebase is not a wrong rule. It is a
 * correct rule with no consumer:
 *
 *   A7's offsiteReason was computed and never passed to the renderer, so a
 *   live critical rule NEVER ONCE FIRED.
 *   A22's one-ask check, `alsoMatched`, and ten e2e scripts: same shape.
 *   A25 had no reference anywhere in lib/ or app/ at all, while its intent
 *   guide actively instructed the opposite behaviour.
 *
 * Every one of those passed types, passed unit tests, and passed the whole
 * verify chain, because a function nobody calls is not wrong — it is absent,
 * and absence is invisible to a test suite that imports it directly.
 *
 * So this checks the CHAIN, not the function: for each rule, that the value
 * is produced, threaded through every hop, and read at the far end. A broken
 * link fails here even though everything still compiles.
 *
 * It is deliberately structural and slightly brittle. A rename that breaks a
 * line below is a prompt to check the chain still joins up, not a nuisance.
 */
import { readFileSync } from "node:fs";


/**
 * Strip comments so a forbidden pattern tests what the file DOES, not what it
 * says about itself. Deliberately crude — it does not understand a `//` inside
 * a string literal — which is fine here because it only ever makes a forbidden
 * check MORE likely to miss, never more likely to fire falsely.
 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const read = (p) => {
  try { return readFileSync(p, "utf8"); } catch { return null; }
};

let fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) console.log(`  ✓  ${label}`);
  else { fail++; console.log(`  ✗  ${label}${detail ? "\n       " + detail : ""}`); }
};

/**
 * Each link is [file, what must appear in it]. Every link must hold: a chain
 * is only as wired as its weakest hop, and checking only the ends is how
 * "computed, then dropped on the floor mid-way" survives.
 */
const CHAINS = [
  {
    rule: "A7 — the off-site reason reaches the renderer",
    why: "computed and never passed, so offer_offsite_quote rendered empty every time and the turn escalated instead of making the offer",
    links: [
      ["lib/messaging/offsite.ts", /export function offsiteReasonFor/],
      ["lib/messaging/agent-run.ts", /offsiteReason:\s*offsiteReasonFor\(/],
      ["lib/messaging/render.ts", /offsiteReason/],
    ],
  },
  {
    rule: "A25 — the phone branch knows whether we hold a callback time",
    why: "Kate, 2026-09-18: 'Ending without capturing when to call is the defect.' The parser existing is not the rule working",
    links: [
      ["lib/messaging/channel-preference.ts", /export function phoneBranch/],
      ["lib/messaging/render.ts", /phoneBranch\(input\.callback/],
      ["lib/messaging/agent-run.ts", /callback:\s*opts\.callback/],
      ["lib/messaging/scheduler-db.ts", /unreachable_start_hour/],
    ],
  },
  {
    rule: "A25 — the intent guide does not contradict the rule",
    why: "`transferred` read 'Use this for a text-only preference', instructing a handoff exactly where Kate says the handoff IS the defect",
    links: [
      ["lib/messaging/agent-output.ts", /transferred:[^"]*"[^"]*A25/],
    ],
    forbidden: [
      ["lib/messaging/agent-output.ts", /Use this for a text-only preference/i],
    ],
  },
  {
    rule: "A40 — parking reaches the validator, and sees the whole thread",
    why: "Kate's two situations have OPPOSITE failures: a field park that ends having gathered nothing, and a conversation park the bot keeps pressing. A detector nothing calls produces both",
    links: [
      ["lib/messaging/parking.ts", /export function parkKind/],
      ["lib/messaging/agent-output.ts", /reason: "pressed_after_deferral"/],
      ["lib/messaging/agent-output.ts", /reason: "parked_a_field_then_quit"/],
      // The thread, not just the latest message — the pressing happens the
      // turn AFTER the deferral, so a guard reading only customerText is
      // wired but useless.
      ["lib/messaging/agent-run.ts", /customerMessages: history\.filter/],
    ],
  },
  {
    rule: "A40 — the bot actually comes back at the time they named",
    why: "the spec: 'What has never once happened is the bot coming back.' A parser with nothing calling it reproduces exactly that, and every park would look correctly recognised",
    links: [
      ["lib/messaging/park-time.ts", /export function parkReopenAt/],
      // The reminder is written when the customer parks — there is no later
      // moment at which a park becomes true.
      ["lib/messaging/record-inbound.ts", /await setParkReminder\(/],
      ["lib/messaging/stalled-db.ts", /action: "park_reopen"/],
      // And something has to RUN it.
      ["lib/messaging/scheduler.ts", /a\.action === "park_reopen"/],
      // Same carve-out as the stall cadence: a park re-open speaks after
      // ourselves, so the already-answered guard must not refuse it.
      ["lib/messaging/scheduler-db.ts", /a\.action === "park_reopen"/],
    ],
    forbidden: [
      // A park must never trigger A45's hand-back: it is not a cadence.
      ["lib/messaging/scheduler.ts", /park_reopen[\s\S]{0,200}onCadenceSpent/],
    ],
  },
  {
    rule: "A44 — the stall cadence is queued, runs, and is reached by the cron",
    why: "208 of 237 stalled conversations received NOTHING. A cadence nobody sweeps for reproduces that exactly, and the tick would still report ok",
    links: [
      ["lib/messaging/stalled.ts", /export function followUpSchedule/],
      ["lib/messaging/stalled-db.ts", /export async function sweepStalled/],
      // The cron is the only thing that runs it. Without this hop the sweep
      // is a function nobody calls.
      ["app/api/cron/messaging-tick/route.ts", /await sweepStalled\(/],
      // And the scheduler has to know what to DO with a claimed row.
      ["lib/messaging/scheduler.ts", /a\.action === "stall_followup"/],
      // THE CARVE-OUT THAT MAKES THE FOLLOW-UP PRODUCE ANYTHING.
      // draftReply skips when the latest inbound is already answered, which
      // is ALWAYS true of a stalled conversation — the last turn is ours by
      // definition. Without this, all three follow-ups fire and all three
      // skip, and the tick reports a clean run.
      ["lib/messaging/scheduler-db.ts", /!isStallFollowUp && latestInboundIsAnswered/],
    ],
  },
  {
    rule: "A45 — both signals reach the table, and resume fires off the third",
    why: "the resume is keyed on stall_step, which the claim RPC returns only because it is RETURNS SETOF the table — if that ever becomes an explicit column list, onCadenceSpent silently never fires and nothing says so",
    links: [
      ["lib/messaging/call-signals.ts", /export function resumeAfterCadence/],
      // pause, on the inbound path
      ["lib/messaging/record-inbound.ts", /await pauseCallingFor\(/],
      // resume, off the END of the cadence only
      ["lib/messaging/scheduler.ts", /a\.stall_step === FOLLOW_UP_COUNT/],
      ["lib/messaging/scheduler-db.ts", /async onCadenceSpent\(a\)/],
      ["lib/messaging/stalled-db.ts", /export async function resumeCallingIfSpent/],
      // THE HOP THAT WOULD FAIL SILENTLY: the claim must return every column.
      ["supabase/migrations/183_sms_claim_due_actions.sql", /RETURNS SETOF public\.sms_scheduled_actions/],
    ],
  },
  {
    rule: "A46 — the disclosure reaches the message, on the customer's clock",
    why: "approved final text that never gets prefixed is a rule that exists only in a constants file. And outOfHours resolved against the workspace would disclose to the wrong people every evening",
    links: [
      ["lib/messaging/disclosure.ts", /export const DISCLOSURE_OUT_OF_HOURS =/],
      ["lib/messaging/agent-run.ts", /applyDisclosure\(move, rendered/],
      ["lib/messaging/scheduler-db.ts", /outOfHours: !sendingWindow\(/],
      ["lib/messaging/scheduler-db.ts", /customerZone: customerZone\(/],
      // bot_suspected must stay a CONTINUE intent, not an ending.
      ["lib/messaging/agent-output.ts", /"bot_suspected",\n\] as const;|"bot_suspected",/],
    ],
    forbidden: [
      // The retired instruction, and the retired hand-off template.
      ["lib/messaging/render.ts", /I am a real person|real person!/i],
      // Narrowed after a first run: the same phrase is CORRECT under
      // `escalate`, where a hand-off really is happening. Only bot_suspected
      // is forbidden from carrying it.
      ["lib/messaging/render-es.ts", /bot_suspected:\s*\[\s*"Buena pregunta/i],
    ],
  },
  {
    rule: "Auto-rater — guidance reaches the rater and NO bot prompt",
    why: "Kate's heading is \'RATER ONLY — NEVER give this to a bot\'. The spec makes it an acceptance criterion and says PROVABLY, so the separation is checked in both directions rather than assumed",
    links: [
      ["lib/messaging/rater.ts", /HOW TO RATE THIS: \$\{r\.ratingGuidance\}/],
      // The ONLY module that asks for both halves.
      ["lib/messaging/rater-db.ts", /sms_class_a_rule_notes/],
    ],
    forbidden: [
      // The bot-facing loader must not know the notes table exists, and the
      // bot prompt builder must never render the guidance.
      ["lib/messaging/class-a-rules-db.ts", /sms_class_a_rule_notes|rating_guidance/],
      ["lib/messaging/agent-run.ts", /ratingGuidance|rating_guidance/],
      ["lib/messaging/rater.ts", /export function forPrompt/],
    ],
  },
  {
    rule: "Parity 1/5/7 — week-aware ask, stand-off, returning customer",
    why: "the week-aware ask needs the CUSTOMER's zone threaded from the scheduler; without it every ask silently falls back to the generic wording and looks fine",
    links: [
      ["lib/messaging/availability-ask.ts", /export function weekToOffer/],
      ["lib/messaging/render.ts", /weekToOffer\(input\.now, input\.customerZone\)/],
      // the hop that would fail silently
      ["lib/messaging/agent-run.ts", /customerZone: opts\.customerZone/],
      ["lib/messaging/scheduler-db.ts", /customerZone: customerZone\(/],
      ["lib/messaging/agent-output.ts", /reason: "availability_stand_off"/],
      ["lib/messaging/render.ts", /returningCustomerDeclining\(input\.customerText\)/],
    ],
  },
  {
    rule: "Parity 6 — a second property cannot be closed over",
    why: "a second property is a second JOB, lost silently because the conversation looks complete. The guard needs addressesHeld threaded from agent-run or it can never fire",
    links: [
      ["lib/messaging/multi-property.ts", /export function secondPropertyOutstanding/],
      ["lib/messaging/agent-output.ts", /reason: "second_property_uncollected"/],
      ["lib/messaging/agent-run.ts", /addressesHeld: kf\.address/],
      // and asking for the second address must not trip the A13 guard
      ["lib/messaging/agent-output.ts", /const secondProperty = a\.intent === "ask_address"/],
    ],
  },
  {
    rule: "A15 — a requested time is held, never confirmed",
    why: "the likeliest A15 breach in the system. A customer says 'Tuesday at 2?' and the natural reply confirms it, inventing an appointment nobody booked. The validator refuses that; this is the right thing to say instead, and a parser nothing calls leaves the model choosing again",
    links: [
      ["lib/messaging/appointment-time.ts", /export function replyToRequestedTime/],
      ["lib/messaging/render.ts", /replyToRequestedTime\(input\.customerText\)/],
    ],
    forbidden: [
      // The holding line must never grow into a confirmation.
      ["lib/messaging/appointment-time.ts", /that (?:time )?works\b|see you (?:then|at)/i],
    ],
  },
  {
    rule: "A36 — the sending window reads the CUSTOMER's clock",
    why: "the gate read ws.time_zone, so at 9:30am Eastern it permitted a text to California at 6:30 in the morning — under the federal 8am floor",
    links: [
      ["lib/messaging/customer-clock.ts", /export function customerZone/],
      ["lib/messaging/sending-window.ts", /export function sendingWindow/],
      ["lib/messaging/gate.ts", /customerZone:\s*zone\.timeZone/],
      ["lib/messaging/gate-deps.ts", /async customerState/],
    ],
    forbidden: [
      // The specific regression: resolving the window against the workspace.
      ["lib/messaging/gate.ts", /customerZone:\s*ws\.time_zone/],
    ],
  },
  {
    rule: "A36 — the reply delay guards the same boundary the gate enforces",
    why: "it guarded the workspace's 9-8 while the gate refuses against the federal 9pm on the customer's clock, so a lead texting at 8:58pm was answered next morning",
    links: [
      ["lib/messaging/reply-delay.ts", /sendingWindow\(/],
      ["lib/messaging/reply-delay.ts", /customerZone/],
      ["lib/messaging/record-inbound.ts", /customerZone:\s*customerZone\(/],
    ],
  },
];

console.log("\nWRITTEN, OR ACTUALLY WIRED?\n");

for (const chain of CHAINS) {
  const broken = [];
  for (const [file, pattern] of chain.links) {
    const src = read(file);
    if (src === null) { broken.push(`${file} is missing`); continue; }
    if (!pattern.test(src)) broken.push(`${file} no longer matches ${pattern}`);
  }
  for (const [file, pattern] of chain.forbidden ?? []) {
    const src = read(file);
    // COMMENTS ARE NOT CODE, and a forbidden pattern means "the code must not
    // do this". Caught twice: once on render-es.ts, where the phrase was
    // legitimate under a different intent, and once on class-a-rules-db.ts,
    // whose header explains that it does NOT know the notes table exists —
    // the sentence describing the guarantee tripped the check for it.
    if (src !== null && pattern.test(stripComments(src))) {
      broken.push(`${file} STILL matches ${pattern} in CODE — the regression is back`);
    }
  }
  ok(chain.rule, broken.length === 0, broken.join("\n       ") + (broken.length ? `\n       why it matters: ${chain.why}` : ""));
}

/**
 * AND THE CHECK ITSELF MUST BE ABLE TO FAIL.
 *
 * A structural check whose patterns all match trivially is worse than none:
 * it reports the chains as wired without having looked. So one pattern that
 * must NOT be found anywhere proves the matcher is running.
 */
const sentinel = read("lib/messaging/gate.ts");
ok("the matcher is actually reading files",
   sentinel !== null && !/this_string_should_never_appear_in_the_gate/.test(sentinel)
     && /gatedSend/.test(sentinel),
   "gate.ts did not read back, so every result above is meaningless");

console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} CHAIN(S) BROKEN`} — ${CHAINS.length + 1} checks\n`);
process.exit(fail === 0 ? 0 : 1);
