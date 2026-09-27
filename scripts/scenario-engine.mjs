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
import { renderMessage, isSilent } from "../lib/messaging/render.ts";
import { knownFromThread } from "../lib/messaging/known-from-thread.ts";
import { conversationLanguage } from "../lib/messaging/language.ts";
import { offsiteReasonFor } from "../lib/messaging/offsite.ts";
import { normalizeInbound } from "../lib/messaging/inbound-normalize.ts";
import { addressGap } from "../lib/messaging/address.ts";
import { addressesInThread, secondPropertyOutstanding } from "../lib/messaging/multi-property.ts";

/** Rapport the model plausibly writes, including the shapes that broke things. */
export const RAPPORTS = ["", "Got it, thank you.", "Happy to help."];

export const COVERS = "interior painting, exterior painting, cabinets and drywall";

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
  const ownWords = normalizeInbound(text, mediaCount).text ?? "";
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
    offsiteReason: offsiteReasonFor(ownWords),
    covers: COVERS,
    language,
    secondProperty: wantsSecondAddress,
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
