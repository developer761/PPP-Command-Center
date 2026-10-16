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
import { classifyInbound } from "../lib/messaging/compliance.ts";
import {
  END_INTENTS, CONTINUE_INTENTS, NURTURE_END_INTENTS, NURTURE_CONTINUE_INTENTS,
} from "../lib/messaging/agent-output.ts";
import { waysThrough } from "./scenario-engine.mjs";

/**
 * WHAT THIS CANNOT SEE: see scenario-engine.mjs. It proves what the RULES do,
 * not what agent-run remembers to pass them.
 */
let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓  ${label}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  ✗  ${label}${extra ? "  " + extra : ""}`); }
};

/**
 * THE SCENARIOS. One row per thing a customer actually does.
 *
 * `wants` is the intent that SHOULD be available — not the one the model must
 * pick, which is its judgement, but one it must not be prevented from picking.
 */
export const SCENARIOS = [
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

  /**
   * PARITY 6, FOUND IN THE PERSONA HUNT. `success` was refused for the LIFE of
   * a two-property conversation, because addressesHeld was built from the one
   * address column and so could never reach two. Nothing looked broken — the
   * bot kept talking and the lead ended as a follow-up instead of a booked
   * estimate. The old "has two properties" row above could not see it: it never
   * gets far enough to try to close.
   */
  { name: "two properties, BOTH addresses given, ready to close",
    history: [
      "I have two rental properties I need quoted, one in Garden City and one in Hempstead",
      "both need the interiors done, 3 bedrooms each",
      "first one is 12 Oak St, Garden City NY 11530",
      "the other is 44 Elm Ave, Hempstead NY 11550",
      "tom@example.com",
    ],
    text: "weekday mornings work best",
    priorIntents: ["ask_project_details", "ask_address", "ask_contact", "ask_availability"],
    known: { inquiryScope: "interior painting, 3 bedrooms in each of two rentals",
      address: "12 Oak St, Garden City NY 11530", email: "tom@example.com",
      phone: "999-784-6046", name: "Tom" },
    wants: "success" },

  /**
   * THE SAME CLOSE, IN THE ORDER IT ACTUALLY ARRIVES.
   *
   * The scenario above gives availability in the CURRENT message, so the A4
   * gap is null and the close is allowed. Live, the order is the other way
   * round: availability is answered, the bot asks for the second property,
   * and the address is the message being validated. Found in the sandbox
   * 2026-10-01 — `success` was refused with "they named a time but no day",
   * because the guard re-read the current message and found an address. All
   * four legs were collected and the conversation could not close.
   */
  /**
   * A NAMED EVENT, DEFERRED — the scenario that caught two rules leaving no
   * legal first move between them, 2026-10-05.
   *
   * A40 (2) stops collection once they defer; A40's note says a named event
   * runs A7's ladder first, and that ladder's first rung IS an availability
   * ask. The harness had no closing scenario, so the collision only showed up
   * in the sandbox. It is here now.
   *
   * The event is named ONCE and referred to loosely afterwards, which is the
   * half that made the detector say "no event" on the turn that mattered.
   */
  /**
   * KATE'S #4, 2026-10-05: "We wouldn't be able to provide an in-person
   * estimate without a confirmed address, so a phone pricing would be
   * offered/required in this case."
   *
   * Found in the sandbox: the customer refuses the address, the bot collects
   * everything else and then tries to CLOSE, which is refused for the address
   * it does not hold — a refusal and a handover where Kate wants a phone
   * price. phone_pricing was legal the whole time; nothing told the model to
   * reach for it.
   */
  { name: "refuses the address, so it has to be a phone price",
    history: [
      "i need my kitchen and living room painted",
      "id rather not give my address out over text",
      "Dana Reed, dana@example.com",
    ],
    text: "Wednesday afternoon works",
    priorIntents: ["ask_project_details", "ask_address", "ask_contact", "ask_availability"],
    known: { inquiryScope: "kitchen and living room", email: "dana@example.com",
      phone: "999-784-6046", name: "Dana" },
    wants: "phone_pricing",
    refuses: "success" },

  /**
   * THE RUNG ABOVE IT, which the scenario above skips by handing the harness a
   * priorIntents that already contains ask_contact.
   *
   * Played live 2026-10-05: at THIS point the model reached straight for
   * phone_pricing and was refused — "details_never_collected: contact details
   * was never asked for or confirmed". Kate puts phone_pricing in the set that
   * owes all three legs ("the quote going out by text or phone still requires
   * all three here"), so a phone price is where this ENDS, not how it escapes.
   * The legal move is to ask for contact first, and nothing asserted one
   * existed.
   */
  /**
   * DODGED, NOT REFUSED — and the difference decides whether the flow may
   * advance. Played live 2026-10-05:
   *
   *   bot       "What's the address for the project?"
   *   customer  "what times do you have available this week?"
   *   bot       answered honestly, then asked for NAME AND EMAIL
   *   ...and never asked for the address again, so four turns later the close
   *   was refused for the address we never got, and the lead went to a person.
   *
   * Answering was right (A29). Advancing was not. A41 lets the flow move past
   * a REFUSAL; a question is not a refusal, and this is the commonest way an
   * address ask goes unanswered. A11 is the most-breached rule in the corpus.
   *
   * TOLD THE MODEL FIRST, AND IT DECLINED. The prompt gained "a question back
   * is not an answer" and the next live replay advanced to ask_contact anyway,
   * so `address_question_walked_past` is what makes the instruction true.
   *
   * `refuses: ask_contact` is the whole point — advancing to the NEXT field is
   * the bug. The run prints the reason, so a pass here cannot be the generic
   * question_left_unanswered standing in for it.
   */
  { name: "dodges the address with a question, so the flow may not advance",
    history: ["i need my living room painted"],
    text: "what times do you have available this week?",
    priorIntents: ["ask_project_details", "ask_address"],
    known: { inquiryScope: "living room" },
    wants: "answer_question",
    refuses: "ask_contact" },

  /*
    THE RELEASE — that it lets go after two asks — is NOT testable here, and
    the reason is the harness rather than the rule. The guard only fires when
    the customer's message is a QUESTION, and a question also means every
    intent owes an answer; the harness has only generic rapport ("Got it,
    thank you.") to offer, so ask_contact is refused as
    question_left_unanswered whatever this guard does. A scenario asserting
    the release would fail for a reason that has nothing to do with it.
    Proved in __tests__/messaging/address-dodged.test.ts instead, where the
    free text can carry the answer.
  */

  { name: "refuses the address: the phone price is not a way out of the flow",
    history: [
      "i need my kitchen and living room painted",
      "id rather not give my address out over text",
    ],
    text: "no im not giving that out, i told you",
    priorIntents: ["ask_project_details", "ask_address"],
    known: { inquiryScope: "kitchen and living room", phone: "999-784-6046" },
    wants: "ask_contact",
    refuses: "phone_pricing" },

  /**
   * And the WORDING of the re-ask, the other half of the same run: a refusal
   * is not a PARTIAL address, so A11's gap narrowing did not apply and the
   * second ask was the plain question over again — "What address should we
   * have the estimator go to?" Kate's zip floor applies here too.
   */
  { name: "the second address ask narrows to the zip and says why",
    history: ["i need my kitchen and living room painted"],
    text: "id rather not give my address out over text",
    priorIntents: ["ask_project_details", "ask_address"],
    known: { inquiryScope: "kitchen and living room" },
    wants: "ask_address",
    saysMatch: /zip code to price it accurately/i },

  { name: "blocked on a closing, then defers",
    history: [
      "we want the whole upstairs painted but we are closing on the house on the 14th",
      "18 Bayview Rd, Massapequa NY 11758",
      "Dana Reed, dana@example.com",
    ],
    text: "like I said we cant do anything until after the closing, I'll get back to you",
    priorIntents: ["ask_project_details", "ask_address", "ask_contact"],
    known: { inquiryScope: "the whole upstairs", address: "18 Bayview Rd, Massapequa NY 11758",
      email: "dana@example.com", phone: "999-784-6046", name: "Dana" },
    wants: "ask_availability",
    refuses: "schedule_follow_up" },

  { name: "two properties, availability FIRST and the second address last",
    history: [
      "we have two rental properties that both need the living room and hallway painted",
      "12 Oak St, Garden City NY 11530",
      "Tom Smith, tom@example.com",
      "Wednesday afternoon works",
    ],
    text: "45 Pine St, Garden City NY 11530",
    priorIntents: ["ask_project_details", "ask_address", "ask_contact", "ask_availability", "ask_address"],
    known: { inquiryScope: "living room and hallway in each of two rentals",
      address: "12 Oak St, Garden City NY 11530", email: "tom@example.com",
      phone: "999-784-6046", name: "Tom" },
    wants: "success" },

  { name: "two properties, only ONE address given, must not close",
    history: [
      "I have two rental properties I need quoted, one in Garden City and one in Hempstead",
      "both need the interiors done, 3 bedrooms each",
      "first one is 12 Oak St, Garden City NY 11530",
      "tom@example.com",
    ],
    text: "weekday mornings work best",
    priorIntents: ["ask_project_details", "ask_address", "ask_contact", "ask_availability"],
    known: { inquiryScope: "interior painting, 3 bedrooms in each of two rentals",
      address: "12 Oak St, Garden City NY 11530", email: "tom@example.com",
      phone: "999-784-6046", name: "Tom" },
    wants: "ask_address", refuses: "success", saysMatch: /second property/i },
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
  /**
   * A11, FOUND IN THE SIMULATOR. The gap ask was built and the model went
   * round it: "Is 482 Marchmont Ave the correct address for the estimate?" —
   * a yes to that banks a street with no zip as the confirmed address.
   */
  { name: "gives a street but no zip, all in the first message",
    text: "I need the kitchen and two bedrooms painted, its 482 Marchmont Ave",
    wants: "ask_address", refuses: "confirm_address", saysMatch: /zip/i },

  { name: "gives a street but no zip", text: "its 482 Marchmont Ave",
    priorIntents: ["ask_project_details", "ask_address"], known: { inquiryScope: "paint the kitchen and two bedrooms" }, wants: "ask_address" },
  { name: "gives a zip but no street", text: "11530",
    priorIntents: ["ask_project_details", "ask_address"], known: { inquiryScope: "paint the kitchen and two bedrooms" }, wants: "ask_address" },
  { name: "refuses to give the street", text: "I would rather not give my address over text",
    priorIntents: ["ask_project_details", "ask_address"], known: { inquiryScope: "paint the kitchen and two bedrooms" }, wants: "acknowledge_negative" },

  /**
   * PARITY 7, FOUND IN THE PERSONA HUNT. The acknowledgement never fired,
   * because both halves had to be in ONE message and a real customer splits
   * them across turns. The bot just asked again.
   */
  { name: "returning customer refuses, having said so two turns earlier",
    history: [
      "we used you guys a couple years back for the upstairs",
      "the upstairs hallway and two bedrooms need redoing",
    ],
    text: "you already have it",
    priorIntents: ["ask_project_details", "ask_address"],
    known: { inquiryScope: "repaint the upstairs hallway and two bedrooms" },
    wants: "ask_address", saysMatch: /still accurate/ },

  /**
   * A13, FOUND IN THE SIMULATOR. The scope was read from the NEWEST message
   * only, so "text is fine" wiped the bedroom the bot had just quoted and it
   * asked "What are you hoping to have painted?" about it.
   */
  { name: "described the job, then replied with something that has no job in it",
    history: ["just give me a ballpark, how much for a 12x14 bedroom? I don't want an appointment"],
    text: "text is fine",
    priorIntents: ["present_offsite_quote"],
    wants: "ask_address", refuses: "ask_project_details" },

  /**
   * THE "OK" WALL. Played in the simulator: a customer who answers every
   * question with "ok" and gives nothing. The stage advances on having ASKED
   * (A3's legs are satisfied by the ask, so a refusal cannot jam the flow), so
   * after four turns the bot is at stage 4 holding NOTHING. It must not be
   * able to call that a success.
   *
   * Live, the bot chose `escalate` on the fourth "ok" — a person, and no
   * handover message. This asserts the floor underneath that judgement.
   */
  { name: "says only ok, four times, and gives nothing",
    history: ["Hola, necesito pintar mi casa por dentro. No hablo ingles", "ok", "ok", "ok"],
    text: "ok",
    priorIntents: ["ask_address", "ask_contact", "ask_availability"],
    wants: "escalate", refuses: "success" },

  /**
   * A15, FOUND IN THE SIMULATOR. The bot answered "Can you come Tuesday at 2?"
   * with "What's the address for the project?" — correct in that it promised
   * nothing, and silent on the thing they actually asked.
   */
  { name: "names a time while the flow still needs an address",
    text: "I need the kitchen and two bedrooms painted. Can you come Tuesday at 2?",
    wants: "ask_address", saysMatch: /check the calendar/i },

  /**
   * A6's CONVERSE, FOUND IN THE SIMULATOR. A returning customer wrote "now I
   * need the hallway and two bedrooms redone" and the bot answered "We can
   * provide a quick quote for this project. Do you prefer text or email?" —
   * a remote quote on a two-room interior job, which A6 says must be seen.
   * The route came back null because "redone" described no work and a room
   * count alone was not allowed through the gate.
   */
  { name: "two rooms, phrased without a painting verb",
    text: "we used you guys a couple years back for the upstairs, now I need the hallway and two bedrooms redone",
    wants: "ask_address", refuses: "present_offsite_quote" },

  /**
   * THE STAND-OFF, FOUND IN THE SIMULATOR. They asked twice what times we
   * have; the bot deferred to the estimator, correctly, and then asked them a
   * THIRD time in the same breath.
   */
  { name: "asked us for times twice, so nothing asks them again",
    history: [
      "we are a dentists office and need the waiting room painted, just the one room",
      "12 Oak St, Garden City NY 11530. What times do you have available this week?",
    ],
    text: "no, just tell me what times you have and I'll pick one",
    priorIntents: ["ask_address", "ask_contact"],
    known: { inquiryScope: "dentist office waiting room", address: "12 Oak St, 11530" },
    wants: "defer_to_estimator", refuses: "ask_availability",
    saysMatch: /^(?!.*what (?:days|times|sort of days)).*$/i },

  /**
   * FROM A REAL DRAFT IN THE APPROVAL QUEUE, 2026-09-27. The customer wrote
   * "Need the whole interior done before we move in on the 30th" and the
   * queued reply was "What are you looking to have painted?" — A13, waiting
   * for a person to approve it.
   */
  { name: "bounded the job without a painting verb",
    text: "Need the whole interior done before we move in on the 30th",
    wants: "ask_address", refuses: "ask_project_details" },

  /**
   * CHANGING YOUR MIND, FOUND IN THE SIMULATOR. The reply was rejected
   * out_of_order because three named rooms and a bounded floor captured no
   * scope, so the stage fell back to 0 and the customer got nothing.
   */
  { name: "expands the job after the bot has already quoted the small version",
    history: ["just my bedroom please"],
    text: "actually scratch that, we want the whole downstairs done, kitchen living room and dining room",
    priorIntents: ["present_offsite_quote"],
    wants: "ask_address" },

  /**
   * A4 — A DAY IS NOT A WINDOW. Kate: "'Wed & Friday this week works best' is
   * NOT availability collected — the estimator cannot be booked against it.
   * THE TEST: could a person reply 'you're booked for X' without asking
   * anything further?" The remedy is to ask for the missing half.
   */
  { name: "names days but no time window",
    history: ["paint the kitchen and two bedrooms", "12 Oak St, Garden City NY 11530", "tom@example.com"],
    text: "Wednesday or Friday works best",
    priorIntents: ["ask_project_details", "ask_address", "ask_contact", "ask_availability"],
    known: { inquiryScope: "paint the kitchen and two bedrooms", address: "12 Oak St, 11530",
      email: "tom@example.com", name: "Tom", phone: "999-784-6046" },
    wants: "ask_availability", refuses: "success", saysMatch: /time|window|morning|afternoon/i },

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

  /**
   * ── SPANISH, PAST THE FIRST MESSAGE ───────────────────────────────────
   *
   * One scenario reached Spanish ("writes in Spanish" → ask_address) and
   * stopped there, so every Spanish template after the opening question was
   * shipped untested. render-es.ts is a full parallel copy of the wording —
   * the fix-lands-on-one-twin shape with a whole file as the twin — and the
   * zip floor and the no-address phone price both just added an ES half.
   *
   * These walk the same legs the English ones do and assert the reply is
   * actually IN Spanish, because the failure that matters is not a missing
   * template, it is an English sentence going to somebody who told us they do
   * not speak it.
   */
  /**
   * THE ADDRESS IS IN US FORMAT, and that is not laziness in the fixture.
   *
   * Checked against the 1,298 graded conversations in production: THREE carry
   * any Spanish at all, and the only Spanish-street-word hit in the whole
   * corpus is "7720 El Camino Real" — an English-context US street NAME. So a
   * Spanish-FORMATTED street ("Calle 12 Oak") appears zero times, and teaching
   * STREET_IN_PROSE the words calle/avenida/camino would mis-read that real
   * address while fixing nothing anybody has ever sent. A Spanish speaker in
   * Nassau County writes their address the way the post office does.
   *
   * Spanish still matters: one of those three IS a real customer writing
   * "Quiero pintar el exterior de mi vivienda". What has to hold is that the
   * REPLIES stay Spanish all the way through, which is what these check.
   */
  { name: "es: gives the address", text: "12 Oak St, Garden City NY 11530", speaks: "es",
    history: ["Hola, necesito pintar el interior de mi casa, tres recámaras y el pasillo"],
    priorIntents: ["ask_project_details", "ask_address"],
    known: { inquiryScope: "pintar el interior, tres recámaras y el pasillo" },
    wants: "ask_contact",
    saysMatch: /[áéíóúñ¿]|correo|nombre|estimado/i },

  /**
   * AND THE LANGUAGE HAS TO SURVIVE A MESSAGE WITH NO LANGUAGE IN IT.
   *
   * "Ana Ruiz, ana@example.com" is not Spanish, or English, or anything — a
   * name and an email carry no markers at all. conversationLanguage reads the
   * WHOLE thread for exactly this reason, so the history here is the test: a
   * Spanish conversation must not flip to English the moment somebody answers
   * with their contact details.
   */
  { name: "es: gives contact details", text: "Ana Ruiz, ana@example.com", speaks: "es",
    history: [
      "Hola, necesito pintar el interior de mi casa, tres recámaras y el pasillo",
      "12 Oak St, Garden City NY 11530",
    ],
    priorIntents: ["ask_project_details", "ask_address", "ask_contact"],
    known: { inquiryScope: "pintar el interior, tres recámaras y el pasillo",
      address: "12 Oak St, 11530" },
    wants: "ask_availability",
    saysMatch: /[áéíóúñ¿]|días|semana/i },

  { name: "es: asks whether it is a bot", text: "oiga, es una persona real o un robot?",
    speaks: "es", wants: "bot_suspected", saysMatch: /[áéíóúñ¿]|persona|equipo/i },

  /**
   * THE ONE THAT USED TO SEND NOTHING AT ALL.
   *
   * isSilent splits Kate's two discards by asking whether the customer NAMED
   * work we do not cover, and that list was English — so "pintan muebles?"
   * fell into the silent branch and a real customer got no reply, with no
   * person seeing it either because a discard is an ending.
   *
   * NO `speaks` HERE, deliberately, and it is not the check being dodged.
   * The reply is Kate's Spanish sentence followed by the workspace's SERVICES
   * LIST, and that list is data — sms_workspace_services, stored in English,
   * one row per service — so what renders is "Sí cubrimos interior and
   * exterior painting, cabinets, wallpaper and drywall repair." Half Spanish,
   * half English, and understandable, but not right. Translating it is a
   * content decision about workspace data rather than anything this code can
   * settle, so it is QUESTIONS_FOR_KATE item 25 and the assertion below tests
   * the part that IS ours: the Spanish sentence renders and is not silence.
   */
  { name: "es: asks for work we do not cover",
    text: "Hola, pintan muebles? Tengo un librero grande y una cómoda",
    wants: "discard",
    saysMatch: /Creo que no podemos ayudar con este proyecto/ },

  { name: "es: refuses the address, so the zip floor applies",
    text: "prefiero no dar mi dirección por mensaje", speaks: "es",
    history: ["necesito pintar mi cocina y la sala"],
    priorIntents: ["ask_project_details", "ask_address"],
    known: { inquiryScope: "la cocina y la sala" },
    wants: "ask_address",
    saysMatch: /código postal/i },

  /**
   * THE SPANISH CLOSE, which is where the live run actually broke.
   *
   * "el miércoles" was answered with A4's refusal — "no day and no time of day
   * has been given anywhere in the conversation" — because the day patterns
   * were English. A Spanish lead that answered every question could not close,
   * and the Spanish "and roughly what time of day?" could not fire either,
   * since the gap only becomes "window" once a DAY has been found.
   */
  { name: "es: names a day, so the ask narrows to the time of day",
    text: "el miércoles", speaks: "es",
    history: [
      "Hola, necesito pintar el interior de mi casa, tres recámaras y el pasillo",
      "12 Oak St, Garden City NY 11530",
      "Ana Ruiz, ana@example.com",
    ],
    priorIntents: ["ask_project_details", "ask_address", "ask_contact", "ask_availability"],
    known: { inquiryScope: "pintar el interior, tres recámaras y el pasillo",
      address: "12 Oak St, 11530", email: "ana@example.com",
      phone: "999-784-6046", name: "Ana" },
    wants: "ask_availability",
    refuses: "success",
    saysMatch: /[áéíóúñ¿]|hora/i },

  { name: "es: gives both halves, so it can close",
    text: "el miércoles por la tarde", speaks: "es",
    history: [
      "Hola, necesito pintar el interior de mi casa, tres recámaras y el pasillo",
      "12 Oak St, Garden City NY 11530",
      "Ana Ruiz, ana@example.com",
    ],
    priorIntents: ["ask_project_details", "ask_address", "ask_contact", "ask_availability"],
    known: { inquiryScope: "pintar el interior, tres recámaras y el pasillo",
      address: "12 Oak St, 11530", email: "ana@example.com",
      phone: "999-784-6046", name: "Ana" },
    wants: "success" },

  /**
   * THE SPANISH PHOTO PATH, which had no scenario at all until 2026-10-13.
   *
   * Every photo scenario was English, so the Spanish photo thanks was never
   * rendered by this harness -- and that is the exact template that shipped
   * "\u00a1Gracias por la foto!" with an inverted mark Mac and Jasmine said
   * never to use. A whole template nobody could see.
   */
  { name: "es: sends a photo, nothing on file yet", text: "hola, le mando una foto",
    mediaCount: 1, speaks: "es", wants: "ask_project_details" },

  { name: "es: sends two photos once the scope is known", text: "aqui estan",
    mediaCount: 2, speaks: "es", history: ["necesito pintar mi sala"],
    known: { inquiryScope: "la sala" }, wants: "confirm_scope" },

  { name: "es: declines the work", text: "No gracias, ya contratamos a alguien más",
    speaks: "es", wants: "lost" },

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
    if (s.refuses) {
      // A rule that can never be satisfied is as wrong as one that never
      // fires, so the scenarios assert BOTH directions.
      const blocked = !open.includes(s.refuses);
      ok(`  …and "${s.refuses}" is correctly refused [${s.name}]`, blocked,
         blocked ? probe(s.refuses) : "AVAILABLE WHEN IT SHOULD NOT BE");
    }
    if (have && s.saysMatch) {
      const said = say(s.wants);
      ok(`  …and it says the right thing [${s.name}]`, s.saysMatch.test(said), JSON.stringify(said));
    }
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
  const { open, sayAll } = waysThrough(s);
  for (const intent of open) {
    for (const said of sayAll(intent)) {
    if (/\$|\b\d+\s*(?:dollars|usd|dolares)\b/i.test(said)) { unsafe++; console.log(`     price in ${s.name}/${intent}: ${said}`); }
    if (/\b\d{1,2}\s*(?:am|pm)\b|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|jueves|viernes)\b/i.test(said)) {
      unsafe++; console.log(`     time in ${s.name}/${intent}: ${said}`);
    }
    /**
     * AND A CLAIM ABOUT OUR OWN CALENDAR, which is neither a price nor a named
     * day and so slipped past both checks above.
     *
     * askAvailability said "We have a few openings this week to meet with you"
     * — Hatch's sentence, copied verbatim into parity gap 1 — on every lead
     * that reached step four, in both languages, while the validator refused
     * the MODEL for writing the same words. Every test in the suite was green.
     */
    if (/\b(?:we|i)\s+(?:have|have got|ve got|do have)\b[^.?!]{0,40}\b(?:opening|openings|availability|slots?|spaces?|times?)\b|\bwe\s+(?:are|re)\s+(?:free|available)\b|\btenemos\b[^.?!]{0,40}\b(?:espacios|disponibilidad|citas)\b/i.test(said)) {
      unsafe++; console.log(`     claims our availability in ${s.name}/${intent}: ${said}`);
    }

    /**
     * ── THREE INVARIANTS ADDED 2026-10-13, EACH FOR A BUG THAT SHIPPED ──
     *
     * All three were live in production inside a week, with the whole suite
     * green over them, because every existing check asked whether a reply
     * RENDERED rather than what it said. These ask what it said.
     *
     * Written as properties rather than as the strings that broke, so the
     * next instance is caught too and not just the one already fixed.
     */

    /**
     * THANKED TWICE. "Thanks for the photo! Thanks, got the photo!" reached
     * customers: the renderer pushes its own photo thanks and the model wrote
     * one as well. One gratitude per message; two reads as a machine.
     */
    const thanks = (said.match(/\b(?:thanks|thank you|gracias)\b/gi) ?? []).length;
    if (thanks > 1) { unsafe++; console.log(`     thanks ${thanks}x in ${s.name}/${intent}: ${said}`); }

    /**
     * INVERTED PUNCTUATION IN WHAT IS ACTUALLY SENT. language.test.ts reads
     * the SOURCE for these, and a "\u00a1" escape walked past it into a
     * customer's message. This reads the OUTPUT, where the spelling is gone.
     */
    if (/[\u00bf\u00a1]/.test(said)) { unsafe++; console.log(`     inverted punctuation in ${s.name}/${intent}: ${said}`); }

    /**
     * AN ENGLISH JOINER INSIDE A SPANISH SENTENCE. "Si cubrimos interior
     * painting, exterior painting, cabinets and drywall." The service NAMES
     * are English on purpose for now (question 25); the word joining them was
     * not, and no test could see it because nothing inspected the sentence.
     */
    const looksSpanish = /\b(?:cubrimos|gracias|disculpe|necesitamos|podemos|le aviso|cotizar|qu\u00e9|c\u00f3digo)\b/i.test(said);
    if (looksSpanish && /\b and \b/i.test(said)) {
      unsafe++; console.log(`     English "and" inside Spanish in ${s.name}/${intent}: ${said}`);
    }
    }
  }
}
ok("no reachable reply quotes a price, names a day, claims an opening, thanks twice, carries inverted punctuation, or joins Spanish with \"and\"", unsafe === 0, `${SCENARIOS.length} scenarios swept`);

/**
 * WHICH INTENTS NO SCENARIO CAN REACH.
 *
 * The sweep above is only as good as the ground it covers. An intent that no
 * scenario ever opens is an intent whose template, wording and guards are
 * tested by nothing here — and this file is the main defence for exactly
 * those, because the unit tests check pieces while this checks sentences.
 *
 * Reported rather than enforced: some intents genuinely need context no
 * scenario sets up, and a check that fails for a legitimate reason gets
 * muted. A GROWING number is the signal to watch.
 */
console.log("");
const reachable = new Set();
for (const s of SCENARIOS) {
  for (const intent of waysThrough(s).open) reachable.add(intent);
}
/**
 * BOTH TRACKS. The first version of this used END_INTENTS + CONTINUE_INTENTS
 * and reported "30 of 25" — more reachable than existed — because those two
 * lists are the NEW LEAD track only. accepted, nurture_check_in,
 * ask_for_decision, ask_check_back and offer_estimator_call live in the
 * nurture lists. A denominator that excludes half the product makes any
 * coverage figure meaningless in the flattering direction.
 */
const allIntents = [...new Set([
  ...END_INTENTS, ...CONTINUE_INTENTS,
  ...NURTURE_END_INTENTS, ...NURTURE_CONTINUE_INTENTS,
])];
const unreachable = allIntents.filter((i) => !reachable.has(i));
console.log(`  intents reachable from at least one scenario: ${reachable.size} of ${allIntents.length}`);
if (unreachable.length) {
  console.log(`  NOT reachable from any scenario — untested by this file:`);
  for (const i of unreachable) console.log(`     ${i}`);
}

/**
 * THE NURTURE TRACK, WHICH HAD FIVE SCENARIOS TO THE NEW LEAD TRACK'S SIXTY-SIX.
 *
 * The quote has already gone out and the job is to get a decision. It is a
 * whole second conversation type, and a past bug had every AM conversation
 * running the NEW LEAD prompt — so thin coverage here has cost before.
 *
 * Probing it on 2026-10-15 found `accepted` legal after every form of
 * decline: "we went with someone else" could be answered "That's great to
 * hear! I'll let the office know so they can get started", and the
 * conversation recorded as accepted rather than lost.
 */
console.log("");
let nurtureStuck = 0;
for (const [label, text] of [
  ["accepts the quote", "yes let's go ahead with it"],
  ["declines the quote", "we went with someone else"],
  ["asks about the price", "is there any flexibility on that price?"],
  ["asks when work can start", "when could you start?"],
  ["needs to think", "we need to think about it for a week"],
  ["asks what's included", "does that include the ceilings?"],
  ["goes quiet then returns", "sorry for the delay, still interested"],
  ["wants to change the scope", "can you redo it for just the kitchen?"],
  ["asks for the quote again", "can you resend the quote?"],
  ["asks to speak to someone", "can someone call me about it?"],
]) {
  const w = waysThrough({ name: label, text, track: "nurture" });
  const sayable = w.open.filter((i) => { try { return !!w.say(i); } catch { return false; } });
  if (!sayable.length) { nurtureStuck++; console.log(`     NOTHING CAN BE SAID in nurture: ${label}`); }
}
ok("every nurture situation leaves something the bot can say", nurtureStuck === 0,
   "10 situations a customer who already has a quote can be in");

/** And a decline is never answered as though they had agreed. */
{
  const w = waysThrough({ name: "nurture decline", text: "we went with someone else", track: "nurture" });
  ok("a declined quote cannot be recorded as accepted",
     !w.open.includes("accepted"),
     w.open.includes("accepted") ? "accepted is still open" : "accepted correctly refused");
}

/**
 * EVERY STATE STILL HAS A LEGAL MOVE.
 *
 * Eleven new refusal reasons were added to validateAction over two days —
 * claimed_to_be_human, offered_to_hold, named_another_company,
 * asked_for_the_held_address, asked_to_retype_held_data,
 * restated_scope_from_chat, discarded_work_we_cover, pursued_after_a_decline,
 * transferred_a_text_only_customer, offsite_job_entered_booking_flow and the
 * A15/A19/A41/A23 wording checks.
 *
 * Each was verified alone. This checks them TOGETHER, in the states where
 * several fire at once, because this codebase's signature failure is two
 * correct rules with no legal move between them — "the best leads couldn't
 * convert". A rule that refuses everything is worse than the rule it
 * enforces, and nothing else here would notice.
 */
console.log("");
let stuck = 0;
for (const [label, scen] of [
  ["decline with every field held", { text: "Not interested, thanks", history: ["I need my living room painted", "123 Main St Garden City NY 11530", "John Smith john@example.com"] }],
  ["decline with nothing held", { text: "We're not moving forward" }],
  ["off-site job, everything held", { text: "just the one accent wall in the living room", history: ["123 Main St Garden City NY 11530", "John Smith john@example.com"] }],
  ["off-site AND a decline", { text: "actually not interested, it's just one accent wall" }],
  ["text-only AND a decline", { text: "text only please, don't call. not interested" }],
  ["partial address, scope just typed", { text: "I need my living room painted at 482 Marchmont Ave" }],
  ["es, photo, partial address", { text: "necesito pintar la sala, estoy en 482 Marchmont Ave", speaks: "es", mediaCount: 1 }],
  ["everything held, availability due", { text: "sounds good", history: ["I need my living room painted", "123 Main St Garden City NY 11530", "John Smith john@example.com 5165551234"] }],
  ["scope typed with a photo", { text: "here's the kitchen I want painted", mediaCount: 1 }],
]) {
  const w = waysThrough({ name: label, ...scen });
  const sayable = w.open.filter((i) => { try { return !!w.say(i); } catch { return false; } });
  if (!sayable.length) { stuck++; console.log(`     NOTHING CAN BE SAID in: ${label}`); }
}
ok("every state leaves at least one thing the bot can legally say", stuck === 0,
   "9 states where several of the new guards fire at once");

// The opt-out path, checked from the other side.
console.log("");
ok("a plain-language opt-out is suppressed, not answered",
   classifyInbound("please take me off your list") === "opt_out");

/**
 * THE NINE PHRASINGS THAT USED TO BE ANSWERED.
 *
 * Widened 2026-10-14 after nine of ten plain-language opt-outs classified as
 * "normal". Swept here as well as in the unit tests because this file is
 * what gets run against production, and an opt-out that is merely classified
 * and never acted on is the one failure nobody is allowed to have.
 */
for (const said of [
  "please halt all communication",
  "please cease all communication",
  "I want to end all communication with you",
  "stop communication",
  "take my number off your list",
  "remove my number from your list",
  "don't keep texting me",
  "remove from list",
  "stop with the constant texting",
]) {
  ok(`"${said}" is an opt-out`, classifyInbound(said) === "opt_out", classifyInbound(said));
}

/** And the other direction: a DECLINE keeps the lead alive. */
for (const said of [
  "No thanks, we hired someone else",
  "we're all set for now",
  "I'm not interested",
  "Can you stop by tomorrow?",
]) {
  ok(`"${said}" is NOT an opt-out`, classifyInbound(said) === "normal", classifyInbound(said));
}
ok("declining the work is NOT suppressed",
   classifyInbound("No thanks, we already hired someone else") === "normal");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass + fail} checks\n`);
process.exit(fail === 0 ? 0 : 1);
