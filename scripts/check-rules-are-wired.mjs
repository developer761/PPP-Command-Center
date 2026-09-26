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
    if (src !== null && pattern.test(src)) broken.push(`${file} STILL matches ${pattern} — the regression is back`);
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
