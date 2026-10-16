/**
 * GIVEN WHAT THE CUSTOMER SAID, WHAT CAN THE BOT LEGALLY SAY BACK?
 *
 * Lifted out of verify-scenarios-e2e.mjs so the persona hunt does not become a
 * THIRD copy of agent-run's wiring. That file's own header complained about
 * holding a second copy; this is the first half of the fix.
 *
 * ── WHAT IT STILL CANNOT SEE ────────────────────────────────────────────
 *
 * It builds the validate context and the render input the way agent-run does,
 * so it proves what the RULES do and not what the CALLER remembers to pass.
 * Delete offsiteReason from agent-run and every check here stays green. One
 * copy instead of three narrows that hole; it does not close it. Closing it
 * means agent-run calling this, which is a bigger change than a hunt should
 * make in passing.
 */
import { validateAction, intentsForTrack, stageFromIntents, asksSomething } from "../lib/messaging/agent-output.ts";
import { renderMessage, isSilent, templateAsks } from "../lib/messaging/render.ts";
import { knownFromThread } from "../lib/messaging/known-from-thread.ts";
import { conversationLanguage } from "../lib/messaging/language.ts";
import { offsiteReasonFor } from "../lib/messaging/offsite.ts";
import { normalizeInbound } from "../lib/messaging/inbound-normalize.ts";
import { addressGap } from "../lib/messaging/address.ts";
import { availabilityGap, availabilityGapAcross } from "../lib/messaging/availability.ts";
import { addressesInThread, secondPropertyOutstanding } from "../lib/messaging/multi-property.ts";
import { jobRoute } from "../lib/messaging/offsite.ts";
import { isAvailabilityStandOff } from "../lib/messaging/availability-ask.ts";
import { coveredPhrase } from "../lib/messaging/agent-run.ts";
import { persistedRow } from "../lib/messaging/live-turn.ts";
import { retractsAvailability } from "../lib/messaging/availability.ts";
import { requestedTime } from "../lib/messaging/appointment-time.ts";

/** Rapport the model plausibly writes, including the shapes that broke things. */
export const RAPPORTS = [
  "",
  "Got it, thank you.",
  "Happy to help.",
  /**
   * The two that shipped bugs, added 2026-10-13.
   *
   * "Thanks, got the photo!" is the rapport that produced "Thanks for the
   * photo! Thanks, got the photo!" in production. It is not a BARE
   * acknowledgement -- it names the photo -- which is exactly why the guard
   * written for pleasantries did not catch it. The list above claimed to
   * include "the shapes that broke things" and did not include this one.
   */
  "Thanks, got the photo!",
];

/**
 * The same shapes in Spanish, kept SEPARATE on purpose.
 *
 * These were briefly in the list above, which put a Spanish rapport in front
 * of an English template -- "Gracias, recibi la foto! I'm an AI assistant..."
 * -- and the sweep duly reported a dozen bugs that were nothing but the
 * harness feeding itself a sentence the model cannot produce. The model
 * replies in the customer's language; the rapport has to follow it.
 */
export const RAPPORTS_ES = [
  "",
  "Entendido, gracias.",
  "Con gusto.",
  "Gracias, recibi la foto!",
];

/**
 * The covered-services phrase, BUILT THE WAY PRODUCTION BUILDS IT.
 *
 * This was a hardcoded English string, which made it invisible to the bug it
 * was sitting on: in a Spanish conversation production joined the list with
 * "and", and so did this constant, so the harness agreed with the defect
 * instead of catching it. A harness that hardcodes what production computes
 * can only ever confirm what somebody already believed.
 *
 * Now it goes through coveredPhrase with the conversation's language, so the
 * joiner is whatever production would really produce. The service LABELS are
 * still English because that is what the workspace actually stores -- that
 * half is QUESTIONS_FOR_KATE item 25 and needs Spanish words from Mac and
 * Jasmine, not a code change.
 */
/**
 * THE REAL CATALOGUE, read off sms_services on 2026-10-13.
 *
 * This was four invented services -- "Cabinets" is not even a label PPP has;
 * the row is "Cabinet refinishing". Four services fit under coveredPhrase's
 * cap, so the harness exercised the un-truncated branch, which production
 * NEVER takes: there are ten rows, all covered by default and zero workspace
 * exceptions, so every real discard truncates to four and appends "and more".
 *
 * The harness was therefore asserting a sentence no customer can receive:
 *
 *   harness      "...cabinets and drywall"
 *   production   "...lime washing, skim coating and more"
 *
 * Keep this in step with sms_services. If a service is added there and the
 * list below still has ten, the only cost is that the cap hides it -- but the
 * four that show are the four customers actually see, so they must be right.
 */
export const COVER_SERVICES = [
  { label: "Interior painting", covered: true },
  { label: "Exterior painting", covered: true },
  { label: "Lime washing", covered: true },
  { label: "Skim coating", covered: true },
  { label: "Flooring", covered: true },
  { label: "Drywall", covered: true },
  { label: "Power washing", covered: true },
  { label: "Wallpaper", covered: true },
  { label: "Cabinet refinishing", covered: true },
  { label: "Minor repairs", covered: true },
];

export const COVERS = coveredPhrase(COVER_SERVICES);

/**
 * A FIXED CLOCK AND ZONE, so the week-aware ask actually renders here.
 *
 * agent-run passes `now: new Date()` and the customer's zone (agent-run.ts).
 * This passed NEITHER, so askAvailability's week-aware wording never rendered
 * in the harness — and that is the template that carried "We have a few
 * openings this week to meet with you" for weeks, in both languages, with
 * every check green. A sweep cannot catch a sentence it never reaches.
 *
 * Fixed rather than `new Date()` because weekToOffer answers differently on a
 * Thursday than on a Monday, and a harness whose output depends on the day it
 * is run is one nobody can read a diff of. Monday, so the ask says "this
 * week"; the Thursday-to-Saturday side is covered by availability-ask's own
 * unit tests.
 */
export const HARNESS_NOW = new Date("2026-09-28T15:00:00Z");
export const HARNESS_ZONE = "America/New_York";

/**
 * Every intent the model could legally choose here, that also produces words.
 *
 * "Produces words" matters as much as "is allowed": an intent that validates
 * and then renders nothing is the bot going silent, which is how three
 * endings behaved on 2026-09-25.
 */
export function waysThrough(scenario) {
  const { history = [], text, mediaCount = 0, track = "new_lead", known = {} } = scenario;
  const priorIntents = scenario.priorIntents ?? [];
  const messages = [
    ...history.map((h) => ({ body: h })),
    { body: text, mediaCount },
  ];
  /**
   * THE ROW, REPLAYED TURN BY TURN, as production builds it — 2026-10-16.
   *
   * This read the scope off the whole thread with no row each time, which
   * production has never done: a live turn reads what earlier turns STORED
   * on the conversation (live-turn.ts persistedRow is the same guarded write
   * draftReply makes). The two answers differed in exactly the place that
   * mattered. Here a scope typed in message one was "customer" for ever;
   * live, it came back off the row as "record" from message two, and the lead
   * who described the job could never be booked. 43% of Kate's first texts,
   * and every check here green, because this harness was looking at a thread
   * production never sees.
   *
   * The email is on the row too now. It was never passed as onFile here, so
   * a scenario's known.email reached the renderer but not the derivation.
   */
  const stage0 = stageFromIntents(priorIntents);
  let row = {
    inquiry_scope: known.inquiryScope ?? null,
    customer_address: known.address ?? null,
    customer_email: known.email ?? null,
  };
  for (let i = 1; i < messages.length; i++) {
    row = persistedRow(row, knownFromThread({
      onFile: { inquiryScope: row.inquiry_scope, address: row.customer_address, email: row.customer_email },
      messages: messages.slice(0, i),
      stage: stage0,
    }));
  }
  const derived = knownFromThread({
    onFile: { inquiryScope: row.inquiry_scope, address: row.customer_address, email: row.customer_email },
    messages,
    stage: stage0,
  });
  /** Production: `priorIntents[priorIntents.length - 1]` (scheduler-db). */
  const lastIntent = scenario.lastIntent ?? priorIntents[priorIntents.length - 1] ?? undefined;
  /** What WE said, oldest first. Only the scenario knows; empty otherwise. */
  const botMessages = scenario.botMessages ?? [];
  const language = conversationLanguage(messages.map((m) => m.body));
  // EXACTLY WHAT agent-run PASSES. The rules read the customer's own words,
  // not the description, because a reaction quotes our sentence back — and a
  // harness that gets this wrong reproduces bugs that are already fixed.
  const inbound = normalizeInbound(text, mediaCount);
  const ownWords = inbound.text ?? "";
  // EXACTLY AS agent-run BUILDS THEM (agent-run.ts). Every address the thread
  // holds, not the one stored column — the single-column version could never
  // reach two, so `success` was refused for the life of a two-property
  // conversation.
  const customerSaid = [...history, ownWords];
  const addressesHeld = addressesInThread({ customerMessages: customerSaid, onFile: derived.address });
  const wantsSecondAddress = secondPropertyOutstanding({ customerMessages: customerSaid, addressesHeld });

  const ctx = {
    track,
    knownFields: {
      name: !!known.name,
      phone: !!known.phone,
      email: !!known.email,
      address: !!derived.address,
      inquiryScope: !!derived.inquiryScope,
    },
    stage: track === "new_lead" ? derived.stage : undefined,
    priorIntents,
    // A11: WHICH HALF is missing. agent-run passes this, and without it a
    // partial address reads as a complete one and blocks the ask.
    addressGap: derived.address ? addressGap(derived.address) : undefined,
    customerText: ownWords,
    /**
     * BOTH OF THESE WERE MISSING, and their absence hid two whole rules.
     *
     * agent-run passes them. Without them ctx.customerMessages is undefined,
     * so validateAction's A40 deferral check and its second-property check
     * both short-circuit and never run — which means the "has two properties"
     * scenario in verify-scenarios-e2e was green over a rule that was never
     * reached, and that is how the multi-property defect survived.
     *
     * customerMessages EXCLUDES the current message, because validateAction
     * appends ctx.customerText itself.
     */
    customerMessages: history,
    addressesHeld,
    /**
     * A THIRD FIELD agent-run PASSES AND THIS DID NOT (agent-run.ts:512).
     *
     * Without it the "did this turn answer their question" guard reads a
     * different world here than in production, so a scenario could pass or
     * fail for a reason the live bot would never hit. Found when a new A15
     * scenario refused ask_address in the harness while the deployed bot
     * allowed it.
     */
    templateAsks: (intent) => templateAsks(intent, history.length),
    /**
     * A4, FOR THE CLOSE. Across the whole conversation, and from the
     * CUSTOMER's own words — matching agent-run exactly.
     *
     * Was availabilityGap(inbound.description) here and in production. Two
     * faults in one line: it asked only about the current message, so every
     * turn after the availability turn reported nothing bookable and a fully
     * collected conversation could not close; and on a bare reaction the
     * description quotes our own question back, so a thumbs-up on "What days
     * work best for you this week?" read as a DAY supplied.
     */
    availabilityGap: availabilityGapAcross(customerSaid, {
      justAskedForAvailability: lastIntent === "ask_availability",
    }),
    /**
     * FOUR MORE THE VALIDATOR GETS IN PRODUCTION, added 2026-10-16 with the
     * row replay above. Each was undefined here, and every rule written
     * `if (ctx.x && ...)` skipped instead of running: A2's coverage guard
     * (serviceArea), the negative-reaction repeat guard (lastIntent and
     * negativeReaction), and the bare "yes" that IS availability when it
     * answers our availability question (justAskedForAvailability, above).
     */
    serviceArea: scenario.serviceArea ?? null,
    lastIntent,
    negativeReaction: inbound.reaction?.sentiment === "negative",
    /**
     * A FOURTH FIELD agent-run PASSES AND THIS DID NOT (agent-run.ts:531).
     *
     * Without it A6's converse — "when the job routes ONSITE and no A7 trigger
     * has fired, do NOT offer a remote quote" — could not fire in the harness
     * at all, so no scenario could ever catch the bot offering one. That is
     * exactly the breach found in the simulator on 2026-09-27.
     */
    jobRoute: jobRoute(derived.inquiryScope, known.area ?? null)?.route ?? null,
    /**
     * WHERE THE SCOPE CAME FROM, which production has always passed and this
     * harness never did.
     *
     * scheduler-db.ts:597 and simulator.ts:419 both set it; the scenario
     * engine left it undefined, so A9 — "never restate scope the customer
     * just typed" — could not be exercised here at all. A context thinner
     * than production disables a rule silently, which is the one thing a
     * harness must never do.
     */
    scopeFromCustomer: derived.scopeFrom === "customer",
  };

  const renderFor = (intent, freeText) => renderMessage({
    intent,
    freeText,
    turn: history.length,
    photos: mediaCount,
    known: {
      address: derived.address, scope: derived.inquiryScope,
      phone: known.phone, email: derived.email ?? known.email, zip: known.zip, state: known.state,
      name: known.name,
    },
    customerText: ownWords,
    /**
     * A SIXTH FIELD THE RENDERER NEVER GOT. The ctx above passes addressGap to
     * the VALIDATOR and this did not pass it to the RENDERER, so A11's gap
     * wording — "And what's the zip code there?" — could not appear in any
     * scenario. agent-run passes it to both (agent-run.ts). A11 is the most
     * broken rule in Kate's grading at 287 breaches, and its remedy was
     * untestable here.
     */
    addressGap: derived.address ? addressGap(derived.address) : undefined,
    /**
     * AN EIGHTH, same shape and same reason as the two below it: agent-run
     * passes it (agent-run.ts) so the refusal re-ask must be reachable here
     * too, or the zip floor is wording no scenario can ever see.
     */
    addressAskedBefore: !derived.address && priorIntents.includes("ask_address")
      && !asksSomething(ownWords),
    /**
     * A SEVENTH FIELD, and the same shape as addressGap: agent-run passes it
     * (agent-run.ts) and this did not, so A4's gap wording could not render in
     * any scenario. Kate: "A DAY IS NOT A WINDOW, AND BOTH ARE REQUIRED. 'Wed
     * & Friday this week works best' is NOT availability collected."
     *
     * From ownWords, exactly as agent-run reads it. This comment used to say
     * the opposite — "from the DESCRIPTION... reading the raw text would scan
     * our own sentence" — and had it exactly backwards. It is the DESCRIPTION
     * that carries our sentence: on a bare reaction it reads `The customer
     * Liked the message: "<our question>"`. ownWords is empty there, because
     * they said nothing, which is what this rule needs to know.
     */
    // agent-run: a retraction names the day it withdraws, so it is not a day supplied.
    availabilityGap: retractsAvailability(ownWords) ? "both" : availabilityGap(ownWords),
    offsiteReason: offsiteReasonFor(ownWords, language),
    covers: coveredPhrase(COVER_SERVICES, language === "es" ? "es" : "en"),
    language,
    now: HARNESS_NOW,
    customerZone: HARNESS_ZONE,
    secondProperty: wantsSecondAddress,
    // Parity 7 needs the thread: the two halves arrive turns apart.
    customerMessages: history,
    availabilityStandOff: isAvailabilityStandOff(customerSaid),
    flowStage: track === "new_lead" ? derived.stage : undefined,
    /**
     * THE RENDERER FIELDS agent-run PASSES AND THIS DID NOT, added 2026-10-16:
     * the track (nurture renders differently), our own past messages (Parity
     * 7's say-it-once cap reads them), and A25's callback as scheduler-db
     * supplies it: the row's unreachable_start_hour, never this message's —
     * production always passes a callback object, so agent-run's
     * statedConstraint fallback is the simulator's path, not the live one.
     */
    track,
    botMessages,
    callback: {
      unreachableStartHour: known.unreachableStartHour ?? null,
      requestedHour: requestedTime(ownWords)?.hour ?? null,
    },
  });

  /**
   * The rapport the model could ACTUALLY have written here.
   *
   * Language, and whether a photo exists. A rapport naming a photo is only
   * reachable when one was sent — the model is told the media count, and it
   * cannot thank somebody for an attachment they did not send. Feeding it to
   * a photoless scenario produced "Thanks, got the photo! Understood, and
   * thanks for the update." and a bug report about a sentence no customer
   * can receive.
   *
   * The harness is allowed to be adversarial. It is not allowed to be
   * impossible: a finding from an input production cannot generate costs the
   * same time to chase as a real one and teaches nothing.
   */
  const base = language === "es" ? RAPPORTS_ES : RAPPORTS;
  const rapports = mediaCount > 0 ? base : base.filter((r) => !/\b(?:photo|foto)/i.test(r));

  const open = [];
  for (const intent of intentsForTrack(track)) {
    for (const freeText of rapports) {
      const v = validateAction({ intent, confidence: 0.97, freeText }, ctx);
      if (!v.ok) continue;
      const rendered = renderFor(intent, v.action.freeText);
      const silent = isSilent({ intent, known: { scope: derived.inquiryScope }, customerText: ownWords });
      if (rendered || silent) { open.push(intent); break; }
    }
  }

  return {
    open: [...new Set(open)],
    derived,
    language,
    ctx,
    /** Why was this one not available? The first real refusal, or the other
     *  failure: it validated and then rendered nothing. */
    probe(intent) {
      let lastReason = null;
      for (const freeText of rapports) {
        const v = validateAction({ intent, confidence: 0.97, freeText }, ctx);
        if (!v.ok) { lastReason = `${v.reason}: ${v.detail}`; continue; }
        if (!renderFor(intent, v.action.freeText)) return "validates but renders nothing";
      }
      return lastReason ?? "available";
    },
    /** What it would actually say. */
    say(intent) {
      for (const freeText of rapports) {
        const v = validateAction({ intent, confidence: 0.97, freeText }, ctx);
        if (!v.ok) continue;
        const out = renderFor(intent, v.action.freeText);
        if (out) return out;
      }
      return "";
    },
    /**
     * EVERY rendering, not just the first one that works.
     *
     * say() returns the first rapport that renders, and RAPPORTS[0] is the
     * empty string -- so say() almost always describes a message the model
     * contributed NOTHING to. Three output invariants were added on top of it
     * and all three were inert: the bugs they were written for live in the
     * interaction between the model's rapport and the template, which say()
     * by construction never shows.
     *
     * Verified by reintroducing all three bugs and watching the sweep stay
     * green before this existed.
     */
    sayAll(intent) {
      const out = [];
      for (const freeText of rapports) {
        const v = validateAction({ intent, confidence: 0.97, freeText }, ctx);
        if (!v.ok) continue;
        const r = renderFor(intent, v.action.freeText);
        if (r) out.push(r);
      }
      return out;
    },
  };
}
