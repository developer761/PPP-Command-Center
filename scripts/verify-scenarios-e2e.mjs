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
import { classifyInbound } from "../lib/messaging/compliance.ts";
import { normalizeInbound } from "../lib/messaging/inbound-normalize.ts";

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
    stage: derived.stage,
    priorIntents,
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
        customerText: ownWords, covers: COVERS, language,
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
        customerText: ownWords, covers: COVERS, language,
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
    ok(`  …and "${s.wants}" is available`, have, have ? "" : probe(s.wants));

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

// The opt-out path, checked from the other side.
console.log("");
ok("a plain-language opt-out is suppressed, not answered",
   classifyInbound("please take me off your list") === "opt_out");
ok("declining the work is NOT suppressed",
   classifyInbound("No thanks, we already hired someone else") === "normal");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass + fail} checks\n`);
process.exit(fail === 0 ? 0 : 1);
