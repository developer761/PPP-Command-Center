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
import { validateAction, intentsForTrack, stageFromIntents } from "../lib/messaging/agent-output.ts";
import { renderMessage, isSilent, templateAsks } from "../lib/messaging/render.ts";
import { knownFromThread } from "../lib/messaging/known-from-thread.ts";
import { conversationLanguage } from "../lib/messaging/language.ts";
import { offsiteReasonFor } from "../lib/messaging/offsite.ts";
import { normalizeInbound } from "../lib/messaging/inbound-normalize.ts";
import { addressGap } from "../lib/messaging/address.ts";
import { availabilityGap } from "../lib/messaging/availability.ts";
import { addressesInThread, secondPropertyOutstanding } from "../lib/messaging/multi-property.ts";
import { jobRoute } from "../lib/messaging/offsite.ts";
import { isAvailabilityStandOff } from "../lib/messaging/availability-ask.ts";

/** Rapport the model plausibly writes, including the shapes that broke things. */
export const RAPPORTS = ["", "Got it, thank you.", "Happy to help."];

export const COVERS = "interior painting, exterior painting, cabinets and drywall";

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
  const derived = knownFromThread({
    onFile: { inquiryScope: known.inquiryScope, address: known.address },
    messages,
    stage: stageFromIntents(priorIntents),
  });
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
    // A4, for the close as well as the ask.
    availabilityGap: availabilityGap(inbound.description),
    /**
     * A FOURTH FIELD agent-run PASSES AND THIS DID NOT (agent-run.ts:531).
     *
     * Without it A6's converse — "when the job routes ONSITE and no A7 trigger
     * has fired, do NOT offer a remote quote" — could not fire in the harness
     * at all, so no scenario could ever catch the bot offering one. That is
     * exactly the breach found in the simulator on 2026-09-27.
     */
    jobRoute: jobRoute(derived.inquiryScope, known.area ?? null)?.route ?? null,
  };

  const renderFor = (intent, freeText) => renderMessage({
    intent,
    freeText,
    turn: history.length,
    photos: mediaCount,
    known: {
      address: derived.address, scope: derived.inquiryScope,
      phone: known.phone, email: known.email, zip: known.zip, state: known.state,
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
     * A SEVENTH FIELD, and the same shape as addressGap: agent-run passes it
     * (agent-run.ts) and this did not, so A4's gap wording could not render in
     * any scenario. Kate: "A DAY IS NOT A WINDOW, AND BOTH ARE REQUIRED. 'Wed
     * & Friday this week works best' is NOT availability collected."
     *
     * From the DESCRIPTION, exactly as agent-run reads it — a reaction or a
     * photo arrives described rather than quoted, and reading the raw text
     * would scan our own sentence.
     */
    availabilityGap: availabilityGap(inbound.description),
    offsiteReason: offsiteReasonFor(ownWords),
    covers: COVERS,
    language,
    now: HARNESS_NOW,
    customerZone: HARNESS_ZONE,
    secondProperty: wantsSecondAddress,
    // Parity 7 needs the thread: the two halves arrive turns apart.
    customerMessages: history,
    availabilityStandOff: isAvailabilityStandOff(customerSaid),
    flowStage: track === "new_lead" ? derived.stage : undefined,
  });

  const open = [];
  for (const intent of intentsForTrack(track)) {
    for (const freeText of RAPPORTS) {
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
      for (const freeText of RAPPORTS) {
        const v = validateAction({ intent, confidence: 0.97, freeText }, ctx);
        if (!v.ok) { lastReason = `${v.reason}: ${v.detail}`; continue; }
        if (!renderFor(intent, v.action.freeText)) return "validates but renders nothing";
      }
      return lastReason ?? "available";
    },
    /** What it would actually say. */
    say(intent) {
      for (const freeText of RAPPORTS) {
        const v = validateAction({ intent, confidence: 0.97, freeText }, ctx);
        if (!v.ok) continue;
        const out = renderFor(intent, v.action.freeText);
        if (out) return out;
      }
      return "";
    },
  };
}
