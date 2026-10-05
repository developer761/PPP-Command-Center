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
   * WHAT THIS ASSERTS, AND WHAT IT CANNOT. The answering half is enforced —
   * `question_left_unanswered` refuses any turn that just asks the next
   * question back, which is why `ask_address` is NOT listed as wanted here:
   * every intent is illegal in this context unless its text answers them, and
   * the harness only has generic rapport ("Got it, thank you.") to offer. So
   * asserting that some OTHER intent is refused would pass for the wrong
   * reason and look like a real test.
   *
   * The half that is prompt-level — answer them and ask for the SAME thing
   * again rather than advancing — is verified by replaying it, not here.
   */
  { name: "dodges the address with a question, so the question gets answered",
    history: ["i need my living room painted"],
    text: "what times do you have available this week?",
    priorIntents: ["ask_project_details", "ask_address"],
    known: { inquiryScope: "living room" },
    wants: "answer_question",
    refuses: "success" },

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
  const { open, say } = waysThrough(s);
  for (const intent of open) {
    const said = say(intent);
    if (!said) continue;
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
  }
}
ok("no reply reachable from any scenario quotes a price, names a day, or claims an opening", unsafe === 0, `${SCENARIOS.length} scenarios swept`);

// The opt-out path, checked from the other side.
console.log("");
ok("a plain-language opt-out is suppressed, not answered",
   classifyInbound("please take me off your list") === "opt_out");
ok("declining the work is NOT suppressed",
   classifyInbound("No thanks, we already hired someone else") === "normal");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass + fail} checks\n`);
process.exit(fail === 0 ? 0 : 1);
