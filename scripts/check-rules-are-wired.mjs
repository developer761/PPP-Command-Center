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
    rule: "A44 — each of the three follow-ups carries its OWN goal into the prompt",
    why: "one generic instruction for all three made the nudges interchangeable, which is the Hatch behaviour A44 replaces; Kate gave three distinct goals on 2026-10-05",
    links: [
      ["lib/messaging/stall-followup-goals.ts", /export function stallFollowUpGoal/],
      // Produced per step, with the scope, and actually placed in the prompt.
      ["lib/messaging/agent-run.ts", /stallFollowUpGoal\(opts\.followUpStep/],
      ["lib/messaging/agent-run.ts", /followUpLine/],
      // And the step has to arrive from the cadence, or it is always absent.
      ["lib/messaging/scheduler-db.ts", /followUpStep/],
      ["lib/messaging/simulator.ts", /followUpStep/],
    ],
    forbidden: [
      /**
       * The line this replaced. If it comes back, all three follow-ups are
       * the same message again and nothing else here would notice.
       */
      ["lib/messaging/agent-run.ts", /then ask for the one thing still outstanding/],
    ],
  },
  {
    rule: "A4 — availability is judged on what the CUSTOMER said, across the thread",
    why: "the close guard read only the current message, so any turn after the availability turn reported nothing bookable and a fully collected conversation could not close; and the narration quotes our own question back, so a thumbs-up read as a day supplied",
    links: [
      ["lib/messaging/availability.ts", /export function availabilityGapAcross/],
      // The validator gets the whole conversation, from the customer's own words.
      ["lib/messaging/agent-run.ts", /availabilityGap:\s*availabilityGapAcross\(customerSaid\)/],
      // The renderer stays per-message, but on ownWords rather than the narration.
      ["lib/messaging/agent-run.ts", /availabilityGap:\s*availabilityGap\(ownWords\)/],
      ["lib/messaging/agent-output.ts", /ctx\.availabilityGap/],
    ],
    forbidden: [
      /**
       * inbound.description is a narration written for the MODEL. On a bare
       * reaction it reads `The customer Liked the message: "What days work
       * best for you this week?"`, so an availability parser finds a DAY in
       * our own question. Both call sites had this; neither may have it again.
       */
      ["lib/messaging/agent-run.ts", /availabilityGap\w*\(\s*inbound\.description/],
    ],
  },
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
      /**
       * The caller's callback has to REACH render. This read
       * `/callback:\s*opts\.callback/` and went red when the object gained a
       * field and became a spread — the value still arrived, only the
       * spelling changed. That is the brittleness this file has been caught
       * by before: link the value, not the punctuation around it.
       */
      ["lib/messaging/agent-run.ts", /opts\.callback/],
      ["lib/messaging/scheduler-db.ts", /unreachable_start_hour/],
      /**
       * A25, Kate 2026-09-28: "if call back time is outside of business
       * hours, state business hours + ask if there is a time that works for
       * them within that timeframe."
       *
       * The hour they named has to reach the branch, or the whole
       * out-of-hours arm is unreachable and holding "call me at 11pm" hands
       * a person a time nobody can call in.
       */
      ["lib/messaging/agent-run.ts", /requestedHour:\s*requestedTime\(/],
      ["lib/messaging/channel-preference.ts", /callbackIsInHours\(input\.requestedHour\)/],
      ["lib/messaging/render.ts", /callback_outside_hours/],
      // ...and the stated hours come from the window that was tested, so the
      // sentence cannot drift from the rule.
      ["lib/messaging/render.ts", /clockHour\(CALLBACK_WINDOW\.startHour/],
    ],
    forbidden: [
      /**
       * The narrated handoff. Kate, 2026-09-28: "we essentially don't want
       * the bot to say 'I'll have a colleague/human reach out then'."
       */
      ["lib/messaging/render.ts", /I'll have someone from the office|I'll get someone on our team/i],
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
      /**
       * AND THE SAME STALE SENTENCE ON THE SCREEN.
       *
       * END_STATES is what somebody GRADING a conversation reads, and it still
       * said Transferred meant "Text-only preference, another language". Both
       * stopped being true — A25's correction and A30 — so a rater would have
       * expected a handoff for Spanish and marked a correct answer wrong. The
       * chain checked the intent guide and never looked at the screen.
       */
      ["lib/messaging/db.ts", /Text-only preference, another language/i],
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
    rule: "A46 — the disclosure reaches the message, and 'once we open' means the OFFICE",
    why: "approved final text that never gets prefixed is a rule that exists only in a constants file. And 'pass them along once we open' is a claim about the OFFICE: resolved from !sendingWindow().open it also fired when it was merely too early on the CUSTOMER's clock, so a Los Angeles customer texting at 8:30 AM was told we would pass their details along once we open, at 11:30 AM Eastern with the office open",
    links: [
      ["lib/messaging/disclosure.ts", /export const DISCLOSURE_OUT_OF_HOURS =/],
      ["lib/messaging/agent-run.ts", /applyDisclosure\(move, rendered/],
      /**
       * THE OFFICE QUESTION, NOT THE SEND-WINDOW QUESTION.
       *
       * This link used to require `outOfHours: !sendingWindow(` — the THIRD
       * chain in this file to hold a defect in place by asserting the shape of
       * the call that caused it. Parity 6 and Parity 1/5/7 were the others, both
       * found the same morning. Asserting that a value is threaded cannot tell a
       * wired rule from a wired bug; where the old shape was the bug it is now
       * `forbidden` as well.
       */
      ["lib/messaging/sending-window.ts", /export function officeIsOpen/],
      /**
       * BOTH HALVES, because each alone fails a case Kate named.
       *
       * This link used to pin `outOfHours: !officeIsOpen(` — the office and
       * nothing else. That is the shape her spec calls out directly: "a
       * single flag gets two of the six states wrong every evening", and her
       * acceptance test failed on it. At 7:30 PM Eastern the office is open
       * until 8, so an Eastern customer got no prefix even though A36 says
       * nothing more reaches them until tomorrow.
       *
       * The old comment below is still right about the OTHER half, which is
       * why the fix is not simply `!sendingWindow().open`: too EARLY on the
       * customer's clock is not "we are closed". So the rule is the office
       * being shut, OR the recipient's own day being over — and both links
       * are pinned, because dropping either one restores a bug that has
       * already shipped once.
       */
      ["lib/messaging/sending-window.ts", /export function recipientDayIsOver/],
      ["lib/messaging/scheduler-db.ts", /!officeIsOpen\(/],
      ["lib/messaging/scheduler-db.ts", /recipientDayIsOver\(/],
      /**
       * AND THE SANDBOX, which passed nothing and so could never show the
       * prefix at all — checked live at 10 PM with the office shut. A rule
       * that cannot appear on the screen somebody uses to verify it is a rule
       * nobody can verify.
       */
      ["lib/messaging/simulator.ts", /!officeIsOpen\(/],
      ["lib/messaging/simulator.ts", /recipientDayIsOver\(/],
      ["lib/messaging/scheduler-db.ts", /customerZone: customerZone\(/],
      // bot_suspected must stay a CONTINUE intent, not an ending.
      ["lib/messaging/agent-output.ts", /"bot_suspected",\n\] as const;|"bot_suspected",/],
    ],
    forbidden: [
      // The conflation: two different questions, and this asked the wrong one.
      ["lib/messaging/scheduler-db.ts", /outOfHours: !sendingWindow\(/],
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
      /**
       * PARITY 7 IS READ OVER THE THREAD, NOT OVER THE LATEST MESSAGE.
       *
       * This link used to assert `returningCustomerDeclining(input.customerText)`
       * — the single-message call that was the defect. The second chain in this
       * file to pin a bug in place by asserting its shape: both halves of the
       * rule have to be in one message for that call to fire, and a real
       * customer splits them across turns, so the acknowledgement never fired
       * at all.
       */
      ["lib/messaging/render.ts", /returningCustomerDecliningInThread\(\{/],
      ["lib/messaging/agent-run.ts", /customerMessages: history\.filter\(\(t\) => t\.role === "customer"\)/],
      // "BUT MOVE ON IF THEY DON'T PROVIDE IT" — capped at one ask, which
      // needs to know what we already said.
      ["lib/messaging/render.ts", /!alreadyAskedToConfirm\(/],
      ["lib/messaging/agent-run.ts", /botMessages: history\.filter/],
    ],
    forbidden: [
      // The single-message call, which could not see a thread.
      ["lib/messaging/render.ts", /returningCustomerDeclining\(input\.customerText\)/],
    ],
  },
  {
    rule: "Call forwarding — a call on a texting number reaches a human",
    why: "Kate moved this into Iteration 1: customers ring the number we text them on. A route that exists but is not signed, or one that 403s, means a customer hears a failed call and concludes PPP does not answer its phone",
    links: [
      ["lib/messaging/voice-forward.ts", /export function forwardTwiml/],
      ["app/api/webhooks/twilio-voice/route.ts", /verifyTwilioSignature/],
      ["app/api/webhooks/twilio-voice/route.ts", /call_forward_to/],
    ],
    forbidden: [
      // Kate asked for forwarding. Recording is a two-party-consent question
      // nobody has asked, and a greeting nobody recorded is not a feature.
      ["lib/messaging/voice-forward.ts", /<Record|<Play|record=/],
      // A refused call is worse than no call. Never 403 a caller.
      ["app/api/webhooks/twilio-voice/route.ts", /status: 403/],
    ],
  },
  {
    rule: "Parity 6 — a second property can be ASKED for, and can be CLOSED",
    why: "the close was refused for the life of a two-property conversation because addressesHeld came from the single address column and could never reach two, while the sentence asking for the second address had no caller at all. Nothing looked broken: the bot kept talking and the lead ended as a follow-up instead of a booked estimate",
    links: [
      ["lib/messaging/multi-property.ts", /export function secondPropertyOutstanding/],
      ["lib/messaging/agent-output.ts", /reason: "second_property_uncollected"/],
      // Asking for the second address must not trip the A13 held-field guard.
      ["lib/messaging/agent-output.ts", /const secondProperty = a\.intent === "ask_address"/],
      /**
       * THE COUNT MUST COME FROM THE THREAD.
       *
       * The chain this replaces asserted `addressesHeld: kf.address` as a
       * required link — it pinned the defect in place. A list built from one
       * column can never hold two, so the rule requiring two could never be
       * satisfied, and the check called that correctly wired.
       */
      ["lib/messaging/agent-run.ts", /addressesInThread\(\{/],
      ["lib/messaging/agent-run.ts", /addressesHeld,/],
      // AND something must ask the question that unblocks the close.
      ["lib/messaging/render.ts", /askSecondPropertyAddress\(\)/],
      /**
       * AND THE MODEL HAS TO BE TOLD THE POLICY.
       *
       * Every part of parity 6 was enforcement — the close refusal, the A13
       * carve-out, the ask sentence — and the prompt never mentioned a second
       * property at all. Played in the simulator, a two-property opener scored
       * 50% and then 45% and escalated both times: the model had no
       * instruction, so it was right to be unsure, and the feature never ran.
       */
      ["lib/messaging/agent-run.ts", /MORE THAN ONE PROPERTY/],
      ["lib/messaging/agent-run.ts", /secondProperty: wantsSecondAddress/],
    ],
    forbidden: [
      /**
       * THE EXACT LINE THAT CAUSED IT. A list built from one field cannot hold
       * two, so a rule that requires two can never be satisfied.
       */
      ["lib/messaging/agent-run.ts", /addressesHeld: kf\.address \? \[kf\.address\] : \[\]/],
    ],
  },
  {
    rule: "A41/A3 — a refused address gets the zip floor, then a phone price",
    why: "played live: 'id rather not give my address out over text' was answered with "
      + "'What address should we have the estimator go to?' — the same question with no "
      + "reason — and then phone_pricing was refused for never having asked for contact. "
      + "Kate: a phone quote 'still requires all three', so it is the END of the flow, not "
      + "a way out of it. Both halves have to be wired or the lead goes to a person",
    links: [
      // The wording exists once and both branches reach it.
      ["lib/messaging/render.ts", /export const ASK_ZIP_WITH_REASON\b/],
      ["lib/messaging/render.ts", /const ASK_ADDRESS_REFUSED = \[ASK_ZIP_WITH_REASON\]/],
      ["lib/messaging/render.ts", /refused\s*\n?\s*\?\s*\(es \? ASK_ADDRESS_REFUSED_ES : ASK_ADDRESS_REFUSED\)/],
      // And BOTH callers set the flag, or the harness cannot see the wording.
      ["lib/messaging/agent-run.ts", /addressAskedBefore: !kf\.address/],
      ["scripts/scenario-engine.mjs", /addressAskedBefore: !derived\.address/],
      // The model is told phone_pricing owes contact, which is what it got wrong.
      ["lib/messaging/agent-run.ts", /A phone quote is NOT a way out of the rest/],
      ["lib/messaging/agent-run.ts", /ASK FOR THOSE FIRST/],
    ],
  },
  {
    rule: "Parity 9 — the workspace FAQ reaches the prompt, and only safe rows do",
    why: "these are BOT-FACING. An answer carrying a price launders a quote past the validator, which sees a question answered rather than a price invented",
    links: [
      ["lib/messaging/workspace-faq.ts", /export function faqsForPrompt/],
      ["lib/messaging/workspace-faq-db.ts", /usableFaqs\(/],
      ["lib/messaging/scheduler-db.ts", /faqsForPrompt\(await loadWorkspaceFaqs/],
      ["lib/messaging/agent-run.ts", /\$\{workspaceFaqs \? /],
      // The prompt section must keep telling the model not to volunteer.
      // Without it a knowledge base becomes a script and every turn grows a
      // second ask. A LINK, not a forbidden — "must contain" is the positive
      // form, and the first attempt wrote it as a negative lookahead that
      // only ever examined the first line of the file.
      ["lib/messaging/workspace-faq.ts", /ONLY WHEN ASKED/],
      /**
       * AND THE INSTRUCTION NOT TO GUESS IS UNCONDITIONAL.
       *
       * "If nothing here covers it, say you will find out rather than
       * guessing" lived INSIDE faqsForPrompt, which returns "" when a
       * workspace has no FAQs — which is every workspace today. So the one
       * instruction that stops the model inventing PPP's business shipped only
       * with the feature that was supposed to make it unnecessary.
       *
       * Asked "are you licensed and insured? and do you have a minimum job
       * size?" against an empty table, the bot replied "Yes, we're fully
       * licensed and insured, and there's no minimum job size." It invented a
       * business policy.
       */
      ["lib/messaging/agent-run.ts", /WHAT YOU DO NOT KNOW/],
      // AND IT MUST NOT THROW. This loader is on the per-turn hot path, where a
      // failed read takes the whole draft down and costs the customer their
      // reply — over a knowledge base whose absence is simply yesterday's
      // behaviour. The one read in this system that fails OPEN.
      ["lib/messaging/workspace-faq-db.ts", /\} catch \(e\) \{/],
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
    rule: "A2 — the bot cannot end on geography against its own lookup",
    why: "the promising direction was guarded and the REJECTING one was not. A customer on a serviced zip who mentions a property in another state could be told 'the zip I have on file is 11530, and unfortunately we do not currently serve your area' — terminally, using the zip that proves the opposite",
    links: [
      ["lib/messaging/agent-output.ts", /a\.intent === "area_not_serviced"[\s\S]{0,120}ctx\.serviceArea === "serviced"/],
      ["lib/messaging/agent-output.ts", /ctx\.serviceArea === "needs_a_person"/],
      // And the lookup has to actually reach the validator.
      ["lib/messaging/scheduler-db.ts", /serviceArea: service\?\.outcome/],
      ["lib/messaging/agent-run.ts", /serviceArea: opts\.serviceArea/],
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
  {
    rule: "A3 — the customer who describes the job themselves can be CLOSED",
    why:
      "the project-details leg is satisfied by an intent, and for that customer neither " +
      "satisfier may legally fire — asking repeats what they said, and confirm_scope would " +
      "echo their own words back. So success was refused for the life of the conversation " +
      "and the refusal is terminal, handing the best lead there is to a person instead of " +
      "closing. scope.ts settled the same deadlock one layer earlier, at ask_address",
    links: [
      // The leg must consult something other than the intent list...
      ["lib/messaging/agent-output.ts", /alsoSatisfiedBy/],
      ["lib/messaging/agent-output.ts", /scopeFromCustomer/],
      // ...and the fact has to reach it from BOTH callers. knownFromThread
      // resolves it; a caller that does not pass it gets the old deadlock.
      ["lib/messaging/known-from-thread.ts", /scopeFrom:\s*"record"\s*\|\s*"customer"/],
      ["lib/messaging/agent-run.ts", /scopeFromCustomer:\s*opts\.scopeFromCustomer/],
      ["lib/messaging/scheduler-db.ts", /scopeFromCustomer:\s*resolved\.scopeFrom === "customer"/],
      ["lib/messaging/simulator.ts", /scopeFromCustomer:\s*derived\.scopeFrom === "customer"/],
    ],
    forbidden: [
      /**
       * The carve-out is the PROJECT leg alone, and it turns on where the
       * scope came from. A version keyed on merely holding one would delete
       * Kate's "HOLDING IS NOT CONFIRMING": a lead-form scope nobody has
       * mentioned still owes a confirmation before the conversation ends.
       */
      ["lib/messaging/agent-output.ts", /alsoSatisfiedBy:\s*\(ctx\)\s*=>\s*ctx\.knownFields/],
    ],
  },
  {
    rule: "A40 — a park is chased on the PARK cadence, not the stall one",
    why:
      "Kate, 2026-09-28: 'a parking cadence would make sense here because the CC has a varied " +
      "approach and the stalled convo cadence wouldn't kick in on these.' Both used to go down " +
      "the stall cadence, so somebody who said 'let me speak to my wife' was nudged the next " +
      "morning, which is the rudeness A40 exists to prevent. The two differ only in spacing — " +
      "exactly the kind of difference that reverts without anything looking broken",
    links: [
      ["lib/messaging/stalled.ts", /PARK_FOLLOW_UP_DAYS/],
      ["lib/messaging/stalled.ts", /days\?: readonly number\[\]/],
      // It has to be CHOSEN at the sweep, not merely defined. Linked on the
      // value reaching followUpSchedule rather than on the ternary that
      // happened to carry it — this chain already went red once because the
      // branch grew a third case and the punctuation moved.
      ["lib/messaging/stalled-db.ts", /days: parkDays/],
      ["lib/messaging/stalled-db.ts", /parkDays = [\s\S]{0,80}PARK_FOLLOW_UP_DAYS/],
      // ...and `parked` has to mean a park: schedule_follow_up with nothing
      // queued behind it. Keyed on the intent alone this would also catch a
      // park that DID name a day and already has its re-open.
      ["lib/messaging/stalled-db.ts", /const parked =[\s\S]{0,120}nothingScheduled/],
      /**
       * A40's other two cases, 2026-09-28. Both are absences — one sends
       * nothing, the other waits a fortnight — and an absence is exactly what
       * stops working without anything looking wrong.
       */
      ["lib/messaging/stalled-db.ts", /asksNotToBeChased\(said\)/],
      ["lib/messaging/stalled-db.ts", /resumeWithoutChasing\(/],
      ["lib/messaging/stalled-db.ts", /parkIsBlockedOnEvent\(said\)/],
      ["lib/messaging/stalled.ts", /EVENT_PARK_FOLLOW_UP_DAYS/],
    ],
    forbidden: [
      /**
       * "Following up is the breach", so the no-chase path must not reuse the
       * cadence-spent note — it says "our three follow-ups went unanswered",
       * which would be a false account of what happened, in the only record
       * of why the conversation moved.
       */
      ["lib/messaging/call-signals.ts", /resumeWithoutChasing[\s\S]{0,400}three follow-ups went unanswered/],
    ],
  },
  {
    rule: "A2 — the lookup's verdict reaches the MODEL, not only the validator",
    why:
      "the prompt says to choose area_not_serviced 'when the state itself is one we do not " +
      "serve' and never says which states those are — SERVICED lives in service-zip.ts and " +
      "serviceArea stopped at the validate context. Confirmed live with a Texas address: the " +
      "bot chose checking_availability, which is correct without the fact and means A2's " +
      "out-of-state script could essentially never fire. Same shape as A7's offsiteReason",
    links: [
      ["lib/messaging/agent-run.ts", /areaVerdict/],
      ["lib/messaging/agent-run.ts", /OUR RECORDS SAY/],
      // It has to be PASSED, not merely accepted as a parameter.
      ["lib/messaging/agent-run.ts", /outcome: opts\.serviceArea/],
      // ...and the validator still has it, because the prompt is guidance and
      // the guard is the thing that cannot be talked round.
      ["lib/messaging/agent-output.ts", /ctx\.serviceArea !== "serviced"/],
      /**
       * The standing instruction must SURVIVE the fact being added. The line
       * qualifies that paragraph; it does not replace it, and without it a
       * model that mistrusts the lookup has nothing telling it not to decide
       * coverage itself.
       *
       * A positive link, not a `forbidden` with a negative lookahead — this
       * check has been written that way before and it does not work, because
       * `.` does not span newlines and the file is one long string.
       */
      ["lib/messaging/agent-run.ts", /never say a place is outside our area off your own judgement/],
    ],
  },
  {
    rule: "the email the customer typed is KEPT, and is what the quote is sent to",
    why:
      "the bot asks for it by name and customer_email was written once at enrolment and " +
      "never again, so the answer went nowhere — and on the off-site route that column is " +
      "the address the quote is SENT to. Third field with this hole, after inquiry_scope " +
      "and customer_address",
    links: [
      ["lib/messaging/email-from-customer.ts", /export function emailFromCustomer/],
      ["lib/messaging/known-from-thread.ts", /emailFromChat/],
      // Persisted, because production scans only the LAST inbound and relies
      // on the record to remember what earlier turns were told.
      ["lib/messaging/scheduler-db.ts", /update\(\{ customer_email: resolved\.email \}\)/],
      ["lib/messaging/scheduler-db.ts", /\.is\("customer_email", null\)/],
      // ...and read back as what we HOLD, or the turn that stores it still
      // believes we have nothing.
      ["lib/messaging/scheduler-db.ts", /email: resolved\.email/],
      ["lib/messaging/simulator.ts", /email: input\.known\?\.email \|\| derived\.email/],
    ],
    forbidden: [
      // The write must stay guarded. Without `.is(..., null)` it would
      // overwrite the office's version with something read out of a text.
      ["lib/messaging/scheduler-db.ts", /update\(\{ customer_email[^}]*\}\)\s*\.eq\([^)]*\)\s*;/],
    ],
  },
  {
    rule: "the sandbox is handed the same context production is",
    why:
      "every guard is written `if (ctx.field && ...)`, so a field the simulator forgets does " +
      "not fail — it silently never runs. priorIntents was missing, which disabled all four " +
      "close guards, and the sandbox closed a conversation as booked on 'Weekdays are better'. " +
      "The sandbox is where the bot is GRADED, so it was showing a more permissive bot than " +
      "the one that ships",
    links: [
      ["lib/messaging/simulator.ts", /priorIntents:\s*input\.priorIntents/],
      ["components/messaging/simulator.tsx", /priorIntents:\s*turns\.map/],
      ["lib/messaging/simulator.ts", /serviceArea:\s*service\?\.outcome/],
      ["lib/messaging/simulator.ts", /workspaceFaqs:\s*faqsForPrompt\(/],
      ["lib/messaging/simulator.ts", /customerZone:\s*customerZone\(/],
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
