/**
 * CAN THE BOT GET THROUGH THIS TURN AT ALL?
 *
 *   npm run verify:scenarios
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────
 *
 * Every rejection found by hand today is the same shape: a real customer
 * message for which the validator refused EVERY move the model could make, so
 * the turn died and a person had to pick it up.
 *
 *   "do you guys paint furniture?"        — out_of_scope_work, then the echo
 *                                           check, then question_left_unanswered
 *   "...I am at 4821 Oak Lane, 75201"     — commitment_in_free_text
 *   Liked "<our own question>"            — question_left_unanswered
 *   a photo with no caption               — the send did nothing at all
 *
 * Each was found by clicking, one at a time, and I missed the address one
 * while looking straight at it. So this asks the question mechanically, for
 * every scenario at once: given what the customer said, is there at least one
 * legal action that produces a message — and is the RIGHT one among them?
 *
 * No model. It probes the gate the model's answer has to pass, which is where
 * all four of those failures actually happened.
 */
import { validateAction, intentsForTrack, stageFromIntents } from "../lib/messaging/agent-output.ts";
import { renderMessage, isSilent } from "../lib/messaging/render.ts";
import { knownFromThread } from "../lib/messaging/known-from-thread.ts";
import { conversationLanguage } from "../lib/messaging/language.ts";
import { offsiteReasonFor } from "../lib/messaging/offsite.ts";
import { classifyInbound } from "../lib/messaging/compliance.ts";
import { normalizeInbound } from "../lib/messaging/inbound-normalize.ts";
import { addressGap } from "../lib/messaging/address.ts";

/**
 * WHAT THIS CANNOT SEE.
 *
 * It builds the validate context and the render input the way agent-run does,
 * which means it holds a SECOND COPY of that wiring. So it proves the gate
 * and the templates behave, and it cannot prove agent-run still passes them
 * what it should — remove offsiteReason from agent-run and this stays green.
 *
 * That is the same two-copies problem this codebase keeps producing, and the
 * honest fix is to lift the render-input construction into one function both
 * call. Until then: this catches what the rules do, not what the caller
 * forgets.
 */
let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓  ${label}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  ✗  ${label}${extra ? "  " + extra : ""}`); }
};

/** Rapport the model plausibly writes, including the shapes that broke things. */
const RAPPORTS = [
  "",
  "Got it, thank you.",
  "Happy to help.",
];

const COVERS = "interior painting, exterior painting, cabinets and drywall";

/**
 * Every intent the model could legally choose here, that also produces words.
 *
 * "Produces words" matters as much as "is allowed": an intent that validates
 * and then renders nothing is the bot going silent, which is how three
 * endings behaved this morning.
 */
function waysThrough(scenario) {
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
  };

  const open = [];
  for (const intent of intentsForTrack(track)) {
    for (const freeText of RAPPORTS) {
      const v = validateAction({ intent, confidence: 0.97, freeText }, ctx);
      if (!v.ok) continue;
      const rendered = renderMessage({
        intent,
        freeText: v.action.freeText,
        turn: history.length,
        photos: mediaCount,
        known: { address: derived.address, scope: derived.inquiryScope, phone: known.phone, email: known.email, zip: known.zip, state: known.state },
        customerText: ownWords,
        offsiteReason: offsiteReasonFor(ownWords),
        covers: COVERS,
        language,
      });
      const silent = isSilent({ intent, known: { scope: derived.inquiryScope }, customerText: ownWords });
      if (rendered || silent) { open.push(intent); break; }
    }
  }
  return { open: [...new Set(open)], derived, language, ctx, probe: (intent) => {
    // Why was this one not available? Report the first real refusal, or say
    // it validated and then rendered nothing, which is the other failure.
    let lastReason = null;
    for (const freeText of RAPPORTS) {
      const v = validateAction({ intent, confidence: 0.97, freeText }, ctx);
      if (!v.ok) { lastReason = `${v.reason}: ${v.detail}`; continue; }
      const rendered = renderMessage({
        intent, freeText: v.action.freeText, turn: history.length, photos: mediaCount,
        known: { address: derived.address, scope: derived.inquiryScope, phone: known.phone, email: known.email, zip: known.zip, state: known.state },
        customerText: ownWords, offsiteReason: offsiteReasonFor(ownWords), covers: COVERS, language,
      });
      if (!rendered) return "validates but renders nothing";
    }
    return lastReason ?? "available";
  }, say: (intent) => {
    for (const freeText of RAPPORTS) {
      const v = validateAction({ intent, confidence: 0.97, freeText }, ctx);
      if (!v.ok) continue;
      const out = renderMessage({
        intent, freeText: v.action.freeText, turn: history.length, photos: mediaCount,
        known: { address: derived.address, scope: derived.inquiryScope, phone: known.phone, email: known.email, zip: known.zip, state: known.state },
        customerText: ownWords, offsiteReason: offsiteReasonFor(ownWords), covers: COVERS, language,
      });
      if (out) return out;
    }
    return "";
  } };
}

/**
 * THE SCENARIOS. One row per thing a customer actually does.
 *
 * `wants` is the intent that SHOULD be available — not the one the model must
 * pick, which is its judgement, but one it must not be prevented from picking.
 */
const SCENARIOS = [
  { name: "opens with the whole job", text: "Hi I need my living room and hallway painted, about 600 sq ft, walls and ceilings", wants: "ask_address", speaks: "en" },
  { name: "job AND address in one message", text: "I need my whole house exterior painted, I am at 4821 Oak Lane, Dallas TX 75201", // They VOLUNTEERED the address, so asking for it is refused — A13 says read
  // it back instead, and confirm_address is what satisfies step 2 here.
  wants: "confirm_address", priorIntents: ["ask_project_details"] },
  { name: "asks for work we do not cover", text: "Hi, do you guys paint furniture? I have a big standalone bookcase and a dresser", wants: "discard" },
  { name: "wants a ballpark price", text: "just give me a ballpark, how much for a 12x14 bedroom? I don't want an appointment", // Not phone_pricing: closing before anything is collected is A3, and
  // refusing it is correct. The turn still has to go somewhere.
  wants: "answer_question" },
  { name: "asks whether it is a bot", text: "wait is this a real person or a bot", wants: "bot_suspected" },
  { name: "writes in Spanish", text: "Hola, necesito pintar mi casa por dentro. No hablo ingles", wants: "ask_address", speaks: "es" },
  { name: "sends a photo with no caption", text: "", mediaCount: 1, wants: "ask_project_details" },
  { name: "likes our own question", text: 'Liked "Sure thing. What are you hoping to have painted?"', priorIntents: ["ask_project_details"], wants: "ask_project_details" },
  { name: "sends a bare thumbs up", text: "👍", priorIntents: ["ask_project_details"], wants: "ask_project_details" },
  { name: "asks to be called", text: "please have someone call me", wants: "schedule_follow_up" },
  { name: "declines the work", text: "No thanks, we already hired someone else", wants: "lost" },
  { name: "is annoyed", text: "why do you people keep texting me, this is the third time and its annoying", wants: "acknowledge_negative" },
  { name: "is a commercial property", text: "we are a dentists office and need the waiting room painted", wants: "ask_address" },
  { name: "answers with only ok", text: "ok", priorIntents: ["ask_project_details"], wants: "ask_project_details" },
  { name: "gives an address only", text: "12 Oak St, Garden City NY 11530", priorIntents: ["ask_project_details", "ask_address"], known: { inquiryScope: "interior painting, 3 bedrooms and the hallway" }, wants: "ask_contact" },
  { name: "gives contact details", text: "tom@example.com", priorIntents: ["ask_project_details", "ask_address", "ask_contact"], known: { inquiryScope: "interior painting, 3 bedrooms and the hallway", address: "12 Oak St, 11530" }, wants: "ask_availability" },
  { name: "gives availability", text: "weekday mornings work best", priorIntents: ["ask_project_details", "ask_address", "ask_contact", "ask_availability"], // "interior painting" alone is NOT project details — A3: "Interior paint is
    // not [complete], because it does not say how many rooms."
    known: { inquiryScope: "interior painting, 3 bedrooms and the hallway", address: "12 Oak St, 11530", email: "tom@example.com", phone: "999-784-6046", name: "Tom" }, wants: "success" },
  { name: "has two properties", text: "I have two rental properties I need quoted, one in Garden City and one in Hempstead", wants: "ask_project_details" },
  { name: "asks a direct question mid-flow", text: "do you do the prep work too?", priorIntents: ["ask_project_details"], wants: "answer_question" },
  { name: "quote already sent, goes quiet", track: "nurture", text: "still thinking about it", wants: "ask_for_decision" },
  { name: "quote already sent, accepts", track: "nurture", text: "yes lets go ahead with it", wants: "accepted" },

  // ── A2: outside the service area ──────────────────────────────────────
  { name: "out of state address", text: "paint the whole exterior, I am at 4821 Oak Lane, Dallas TX 75201",
    known: { zip: "75201", state: "Texas" }, wants: "confirm_address" },

  // ── A7 triggers: the customer's own reason for a remote quote ─────────
  { name: "cannot get to the property", text: "I cannot be at the house for the next month, it is a rental",
    priorIntents: ["ask_project_details"], known: { inquiryScope: "paint the kitchen and two bedrooms" }, wants: "offer_offsite_quote" },
  { name: "asks to be quoted from photos", text: "can you just quote it from the pictures I sent?",
    mediaCount: 2, priorIntents: ["ask_project_details"], known: { inquiryScope: "paint the kitchen and two bedrooms" }, wants: "offer_offsite_quote" },
  { name: "wants the quote by text", text: "can you text me the quote instead of coming out?",
    priorIntents: ["ask_project_details"], known: { inquiryScope: "paint the kitchen and two bedrooms" }, wants: "offer_offsite_quote" },

  // ── A6 rows, as a customer would phrase them ──────────────────────────
  { name: "cabinets in Queens", text: "refinish my kitchen cabinets", wants: "ask_address" },
  { name: "one wall of wallpaper", text: "I want wallpaper hung on one accent wall", wants: "ask_address" },
  { name: "drywall patches", text: "just need a few holes patched in the drywall", wants: "ask_address" },
  { name: "shared space in a building", text: "we need the lobby and corridors of our condo building painted", wants: "ask_address" },

  // ── A11 and A41: partial and refused addresses ────────────────────────
  { name: "gives a street but no zip", text: "its 482 Marchmont Ave",
    priorIntents: ["ask_project_details", "ask_address"], known: { inquiryScope: "paint the kitchen and two bedrooms" }, wants: "ask_address" },
  { name: "gives a zip but no street", text: "11530",
    priorIntents: ["ask_project_details", "ask_address"], known: { inquiryScope: "paint the kitchen and two bedrooms" }, wants: "ask_address" },
  { name: "refuses to give the street", text: "I would rather not give my address over text",
    priorIntents: ["ask_project_details", "ask_address"], known: { inquiryScope: "paint the kitchen and two bedrooms" }, wants: "acknowledge_negative" },

  // ── A40: parking, which is not declining ──────────────────────────────
  { name: "has to check with someone first", text: "let me check with my wife and get back to you",
    priorIntents: ["ask_project_details"], known: { inquiryScope: "paint the kitchen and two bedrooms" }, wants: "schedule_follow_up" },

  // ── A33: a question only the estimator can answer ─────────────────────
  { name: "asks about color matching", text: "can you match the existing color on the brick?",
    priorIntents: ["ask_project_details"], known: { inquiryScope: "paint the kitchen and two bedrooms" }, wants: "defer_to_estimator" },
  { name: "asks when you can come", text: "what times do you have available this week?",
    priorIntents: ["ask_project_details"], known: { inquiryScope: "paint the kitchen and two bedrooms" }, wants: "defer_to_estimator" },

  // ── the unpleasant end of the range ───────────────────────────────────
  { name: "is abusive", text: "stop wasting my time you idiots", wants: "bailout" },
  { name: "wrong number", text: "who is this? I think you have the wrong number", wants: "discard" },

  // ── shapes, not sentences ─────────────────────────────────────────────
  { name: "sends an emoji only", text: "😀", priorIntents: ["ask_project_details"], wants: "ask_project_details" },
  { name: "sends a very long message", text: "hi there so we bought this house last year and its a colonial built in 1974 and honestly the whole thing needs doing, the living room and dining room have wallpaper we hate, the kitchen cabinets are that orange oak, upstairs there are three bedrooms and a hallway, and outside the trim is peeling badly on the south side, we are not in a rush but would like it done before the holidays if possible", wants: "ask_address" },
  { name: "sends two photos with a caption", text: "here is the wall I mean", mediaCount: 2, wants: "ask_project_details" },

  // ── nurture, further in ───────────────────────────────────────────────
  { name: "quote already sent, wants a call", track: "nurture", text: "can the estimator call me to go through it?", wants: "offer_estimator_call" },
  { name: "quote already sent, declines", track: "nurture", text: "we went with someone else, thanks", wants: "lost" },
  { name: "quote already sent, asks a question", track: "nurture", text: "does the price include the primer?", wants: "defer_to_estimator" },
];

console.log("\nEVERY SCENARIO — is there a way through?\n");

for (const s of SCENARIOS) {
  // An opt-out never reaches the agent, so it has no "way through" to find.
  if (classifyInbound(s.text) === "opt_out") {
    ok(`${s.name}: suppressed before the agent runs`, true);
    continue;
  }
  const { open, probe, say } = waysThrough(s);
  ok(`${s.name}: the bot can reply at all`, open.length > 0,
     open.length ? `${open.length} legal` : "EVERY INTENT REFUSED OR SILENT");
  if (s.wants) {
    const have = open.includes(s.wants);
    ok(`  …and "${s.wants}" is available [${s.name}]`, have, have ? "" : probe(s.wants));

    /**
     * AND IT HAS TO COME OUT IN THEIR LANGUAGE.
     *
     * Added after breaking Spanish on purpose and watching all 44 checks stay
     * green: "is there a way through" was never asking what the way through
     * actually SAID.
     */
    if (have && s.speaks) {
      const said = say(s.wants);
      const wrongLanguage = s.speaks === "es"
        ? /\b(?:what|would|your|the|and|please|thanks|address|project|email)\b/i.test(said)
        : /[¿¡]|\b(?:qué|cuál|gracias|dirección|correo)\b/i.test(said);
      ok(`  …and it replies in ${s.speaks}`, !!said && !wrongLanguage, said.slice(0, 64));
    }
  }
}

/**
 * AND NOTHING ANY OF THEM CAN SAY IS A PRICE OR AN INVENTED TIME.
 *
 * The model cannot put either into an outgoing message, because it does not
 * write outgoing messages. This checks the other half: that no TEMPLATE
 * reachable from any of these scenarios carries one either. Kate's A1 and the
 * availability rule are the two that cost PPP money when they break.
 */
console.log("");
let unsafe = 0;
for (const s of SCENARIOS) {
  if (classifyInbound(s.text) === "opt_out") continue;
  const { open, say } = waysThrough(s);
  for (const intent of open) {
    const said = say(intent);
    if (!said) continue;
    if (/\$|\b\d+\s*(?:dollars|usd|dolares)\b/i.test(said)) { unsafe++; console.log(`     price in ${s.name}/${intent}: ${said}`); }
    if (/\b\d{1,2}\s*(?:am|pm)\b|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|jueves|viernes)\b/i.test(said)) {
      unsafe++; console.log(`     time in ${s.name}/${intent}: ${said}`);
    }
  }
}
ok("no reply reachable from any scenario quotes a price or names a day", unsafe === 0, `${SCENARIOS.length} scenarios swept`);

// The opt-out path, checked from the other side.
console.log("");
ok("a plain-language opt-out is suppressed, not answered",
   classifyInbound("please take me off your list") === "opt_out");
ok("declining the work is NOT suppressed",
   classifyInbound("No thanks, we already hired someone else") === "normal");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass + fail} checks\n`);
process.exit(fail === 0 ? 0 : 1);
