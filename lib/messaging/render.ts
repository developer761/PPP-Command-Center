/**
 * Turn a chosen intent into the words that actually go out.
 *
 * agent-run.ts always claimed "the message is rendered from that", but the
 * renderer did not exist — `rendered` was the model's freeText, a field whose
 * own description says "short rapport only, or empty". So the bot picked
 * ask_project_details correctly and then sent "Hi there!". Karan, 2026-09-08,
 * on seeing it: "this is terrible from the bot, absolutely wrong."
 *
 * The split is the safety property, not an implementation detail. The model
 * chooses WHAT to do; these templates choose HOW it is said. A price or a
 * specific appointment time cannot appear in an outgoing message because no
 * template contains one and the model has no channel that reaches the customer
 * except freeText, which is post-filtered. Rendering from the model's prose
 * would throw that guarantee away.
 *
 * Variants exist because Karan's other complaint was that Hatch's openers are
 * identical every time: "the first messages are usually the same, we need to do
 * better." Selection is deterministic on the turn number rather than random —
 * same conversation, same words, so a regression test can assert output.
 */
import { BARE_ACKNOWLEDGEMENT, type Intent, mentionsWorkWeDoNotDo, longestSharedRun } from "./agent-output";
import { tooManyAsks } from "./one-ask";
import type { AddressGap } from "./address";
import type { AvailabilityGap } from "./availability";
import {
  SAYS_ES, ASK_ADDRESS_GAP_ES, ASK_AVAILABILITY_GAP_ES, ASK_ADDRESS_REFUSED_ES,
  PHONE_PRICING_NO_ADDRESS_ES,
} from "./render-es";
import { ASKED_FOR_A_CALL } from "./customer-asks";
import { DISCLOSURE_IN_HOURS } from "./disclosure";
import { phoneBranch, CALLBACK_WINDOW } from "./channel-preference";

/**
 * A whole hour as a customer would read it. 9 → "9am", 20 → "8pm".
 *
 * Spanish says the hour on a 24-hour clock in writing, which is how a
 * business states opening times there, so it is not the same string with the
 * suffix translated.
 */
function clockHour(hour: number, es: boolean): string {
  if (es) return `${hour}:00`;
  const suffix = hour >= 12 ? "pm" : "am";
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}${suffix}`;
}
import { replyToRequestedTime, TIME_IS_ACKNOWLEDGED_BY } from "./appointment-time";
import { weekToOffer, askAvailability, askAvailabilityEs } from "./availability-ask";
import { returningCustomerDecliningInThread, returningCustomerReply, returningCustomerReplyEs, alreadyAskedToConfirm } from "./returning-customer";
import { askSecondPropertyAddress, askSecondPropertyAddressEs } from "./multi-property";
import type { Language } from "./language";

/** Intents that END the conversation without sending anything. Sending a
 *  cheerful sign-off to somebody who asked to be left alone is how a
 *  complaint starts.
 *
 *  bot_suspected USED TO BE HERE, and that is the opposite situation. The
 *  three below are people who have disengaged; somebody typing "is this a
 *  real person or a bot" is the most engaged a customer gets, and they asked
 *  a direct question. Silence is the single worst answer available: it reads
 *  exactly like a bot that has been caught.
 *
 *  Kate's own tag says so — handled_bot_q, "Answered as Emily and ended as
 *  Bot Suspected". Answered. The conversation still hands to a person either
 *  way; this is about whether they hear anything while they wait. */
/**
 * LOST IS NOT HERE ANY MORE.
 *
 * A17 is explicit, and even supplies the sentence: "Acknowledge it warmly in
 * one line and close... 'Understood! We'll be here if things change.' is the
 * RIGHT close here — and is a DEFECT on an opt-out (A24), where the customer
 * asked us to stop contacting them and any re-engagement line breaches it.
 * The same sentence, opposite verdicts."
 *
 * So silence was wrong for exactly one of the two, and lost had it. Somebody
 * who says "no thanks, we already hired someone" got nothing back — while
 * bailout, which is the same shape of ending, already spoke. Found in the
 * simulator playing that customer.
 *
 * msg_liked_loved stays: a thumbs-up on our own message is not a turn, and
 * answering it is how a thread never ends.
 */
export const SILENT_INTENTS: ReadonlySet<Intent> = new Set<Intent>([
  "msg_liked_loved",
  /**
   * ESCALATE SAYS NOTHING, AND THAT IS THE WHOLE POINT OF IT.
   *
   * Iteration 1 spec, Human takeover: "the bot pings the agent, and the agent
   * enters the conversation and answers the customer directly. THE BOT SENDS
   * NO HANDOVER MESSAGE OF ITS OWN." Done when: "The bot sends nothing on the
   * way out — no sign-off, no handover line, nothing that reads as an
   * ending." And: "There is no handover message because we do not want one."
   *
   * It used to render "Let me get one of our team on this. Someone will
   * follow up with you shortly.", which went into the draft body — so a
   * reviewer approving that draft sent the customer the exact seam the spec
   * says to remove. Caught 2026-09-26 while wiring A46.
   *
   * The conversation still moves to human_active with a reason; that is the
   * ping. What changes is that the customer hears from a person next, not
   * from the bot announcing a person.
   */
  "escalate",
]);

/**
 * DISCARD IS TWO DIFFERENT ENDINGS WEARING ONE NAME.
 *
 * Kate's own definition of the outcome says so: "Not an estimate request, OR
 * work we do not cover." Silence is the right answer to the first — nobody
 * wants a cheerful sign-off to a wrong number or a solicitor. It is the wrong
 * answer to the second, and the configuration says so in as many words:
 * "end the conversation as Discarded and say we cannot help with this project
 * but will circle back if that is wrong."
 *
 * It was silent for both. A homeowner asking "do you paint furniture?" got
 * nothing back, ever, and above the escalation threshold no person saw it
 * either — while the geography ending, which is the same situation about a
 * place instead of a thing, sends a polite sentence.
 *
 * The two are told apart by the definition itself, not by a guess: if there
 * is a project on file then an estimate WAS requested, so the discard can
 * only be the second branch.
 *
 * A function rather than a bigger set because agent-run escalates on
 * "rendered nothing and was not meant to" — so if the two disagreed, every
 * wrong number would land on somebody's desk.
 */
export function isSilent(input: {
  intent: Intent;
  known?: { scope?: string | null } | null;
  customerText?: string | null;
}): boolean {
  if (input.intent === "discard") {
    // EITHER SIGNAL IS ENOUGH, and the second one is why the first was not.
    //
    // "Is there a project on file" only recognises work PPP PAINTS — scope
    // capture is built from the rooms and surfaces it sells, so "a standalone
    // bookcase and a dresser" resolved to nothing and a real customer asking
    // a real question got silence again. Which is the exact case this whole
    // branch exists for.
    //
    // So: a project on file, OR the customer naming work we do not cover.
    return !input.known?.scope && !mentionsWorkWeDoNotDo(input.customerText);
  }
  return SILENT_INTENTS.has(input.intent);
}

/**
 * Every intent, exhaustively. The Record type is the point: adding an intent
 * to agent-output.ts without giving it words here fails the type check rather
 * than silently sending an empty message.
 */
/**
 * Exported so a test can hold the templates to Kate's own tone rules.
 *
 * A23 is the most broken rule in her grading by a distance, and three of the
 * four hyphenated compounds the bot was sending came from right here rather
 * than from the model: "the write-up", "an off-site quote", "a friendly
 * check-in". The style check only ever saw the model's rapport, so a template
 * could break the rule on every single send and nothing would ever say so.
 */
export const SAYS: Record<Intent, string[]> = {
  // — Collecting, in the required order —
  ask_project_details: [
    "What are you looking to have painted?",
    "Happy to help. What's the project you're looking to get done?",
    "Sure thing. What are you hoping to have painted?",
  ],
  ask_address: [
    "What's the address for the project?",
    "Where's the property located?",
    "What address should we have the estimator go to?",
  ],
  ask_contact: [
    "And what's the best name and email for the estimate?",
    "Who should we put the estimate under, and what's a good email?",
    "Can I grab your name and email for the quote?",
  ],
  ask_availability: [
    "What days generally work best for you?",
    "Are weekdays or weekends easier on your end?",
    "What sort of days work for you to have someone take a look?",
  ],


  // — Reading back what we already have —
  // Wording lifted from the two conversations Kate graded well, so the good
  // behaviour that already happens by luck happens every time instead.
  confirm_address: [
    "Is {address} the correct address for the estimate?",
    "Just to confirm, is {address} the right address for the project?",
  ],
  confirm_contact: [
    "Is {phone} and {email} the best contact for your appointment and quote details?",
    "Are {phone} and {email} still the best way to reach you about the estimate?",
  ],
  confirm_scope: [
    "Just to confirm, you're looking for: {scope}. Is that right?",
    "So we have this down as: {scope}. Have I got that right?",
  ],

  // — Keeping it moving —
  // Never empty. An acknowledge that renders to "" is a turn where the
  // customer said something and got silence back — the test caught this on the
  // first run, with an empty first variant.
  acknowledge: ["Got it, thank you.", "Perfect, thanks.", "Great, thank you."],
  answer_question: [""],
  // Reads as a person noticing, then handing them the wheel. Deliberately does
  // NOT re-ask: the point is to stop doing the thing they disliked.
  acknowledge_negative: [
    "Sorry about that. What would work better for you?",
    "Apologies, I did not mean to make this harder. How would you rather do this?",
    "Understood, let me not push on that. What would you prefer?",
  ],
  // — A6: OFFSITE REQUIRED. The job routes off-site, so this is the PLAN. —
  //
  // NO REASON. Kate's findings say it outright: "reason clause on an off-site
  // presentation - A6 mandates none." Her goal for the turn: "tell them we can
  // provide a quick quote for this project and ask if they prefer text or
  // email." It states, it does not ask permission, and it never explains
  // itself, because nothing is being departed from — this IS the normal route
  // for a job whose scope is legible without a visit.
  //
  // "REQUIRED DOES NOT MEAN FORCED": if they ask for a visit afterwards they
  // get one. They are simply owed the offer first.
  present_offsite_quote: [
    "We can provide a quick quote for this project. Do you prefer text or email?",
    "Good news, we can put a quick quote together for this one. Would you like it by text or email?",
  ],

  // — A7: OFFSITE OFFERED. The job routes ONSITE, the customer qualifies. —
  //
  // A REASON IS MANDATORY HERE, and this is the only place in the system where
  // that is true. Kate, 2026-09-17: "BECAUSE THE JOB WOULD NORMALLY BE SEEN IN
  // PERSON, SAY SO... 'for projects like this we like to visit in person, but
  // since [reason they qualify], we can provide a quick quote.' This is the
  // ONE place a reason belongs in the ask."
  //
  // The departure is the point. A32 forbids padding a routine ask with a
  // justification; declining what somebody asked for without saying why is a
  // different failure, and the reason is what separates them.
  //
  // {reason} is filled from the qualifier the SYSTEM detected, never from the
  // model: a reason the bot invented for departing from the normal route is
  // worse than no reason at all.
  offer_offsite_quote: [
    "For projects like this we normally like to visit in person, but since {reason}, we can put a quick quote together instead. Would you prefer that or an appointment?",
    "We usually see a project like this in person, though since {reason}, we can get you a quick quote without the visit. Which would you rather do?",
  ],
  escalate: [
    "Let me get one of our team on this. Someone will follow up with you shortly.",
    "I'll pass this to our office so somebody can help properly. They'll be in touch soon.",
  ],

  // — A33: hand the part we cannot answer over, and CARRY ON —
  //
  // "Deflecting is correct; ENDING the conversation in order to deflect is
  // not." Kate's example of what it should sound like: "Possibly, yes. The
  // estimator will take a look at the finish on the brick and let you know
  // the best way to match it and what prep is needed."
  //
  // Note what that does. It answers the part that CAN be answered, names who
  // will answer the rest, and leaves the conversation open. escalate does the
  // opposite: it hands over the whole thing and stops.
  //
  // THE COMMONEST CASE IS THE CALENDAR. "You suggest a time and date", "what
  // is available", "are you available tomorrow morning". The bot has no
  // calendar and never books, so the honest answer is that a person will
  // confirm the time, and the conversation keeps moving in the meantime.
  //
  // Every variant ends on a question, so the turn cannot read as a sign-off.
  // The part that CAN be answered is the model's rapport, which is prepended
  // and post-filtered, so it can never carry a price or a named time.
  defer_to_estimator: [
    "The estimator will confirm that with you directly. In the meantime, what days generally work best on your end?",
    "That's one for the estimator, and they'll go through it with you. What days suit you best?",
    "Our office confirms the timing, so they'll lock that in with you. What sort of days are easiest for you?",
  ],

  // — Nurture: the quote is out, the job is a decision —
  // Wording adapted from PPP's live Quote Sent campaign rather than invented.
  // No name or estimator is interpolated: those would be slots, and a template
  // that greets the wrong person by name is worse than one that greets nobody.
  nurture_check_in: [
    "Hope all is well! Just checking in to see whether you had any questions about the quote we sent over, or have made any decisions yet. Let us know when you get a chance.",
    "Checking in on the quote we sent across. Any thoughts on how you'd like to move forward?",
  ],
  ask_for_decision: [
    "Have you had a chance to look things over and make a decision?",
    "Any thoughts yet on whether you'd like to move ahead?",
  ],
  ask_check_back: [
    "When would be a good time to check back in with you?",
    "No rush at all. When would you like us to follow up?",
  ],
  offer_estimator_call: [
    "I can have your estimator give you a call to walk through the details. Would that help?",
    "Happy to have the estimator who visited get in touch so you can go through it with them directly. Want me to arrange that?",
  ],
  accepted: [
    "That's great to hear! I'll let the office know so they can get you booked in.",
    "Wonderful, I'll pass this straight to the office and they'll be in touch to get you on the schedule.",
  ],

  // — Endings that still say something —
  success: [
    "Perfect, you're all set. Someone from the office will confirm the details with you.",
    "Great, that's everything we need. The office will be in touch to confirm.",
  ],
  /**
   * KATE CORRECTED THE BEHAVIOUR HERE, 2026-10-05, not just the wording.
   *
   * Asked whether a phone-priced conversation counts as contained, she
   * answered about what the bot should DO instead:
   *
   *   "The correct behavior in this case: 'Customer asks for a price, bot
   *    correctly refuses' would be that the bot states that our estimators
   *    provide pricing and that it is setting up that appointment. If they
   *    just want a price, the estimator can provide a quick quote."
   *
   * Ours stopped at the refusal and a vague "someone will reach out", which
   * reads as a brush-off to somebody who asked a direct question. Hers keeps
   * the lead moving: pricing comes from the estimator, the appointment is
   * being arranged, and if a number is all they want they can have one
   * without a visit.
   *
   * STILL NAMES NO TIME. "Setting up that appointment" is the office's
   * process, not a slot — A15 forbids offering or confirming a time, and
   * nothing here does.
   */
  phone_pricing: [
    "Pricing comes from our estimator, so I'm getting that appointment set up for you. If a number is all you need, they can do a quick quote instead.",
    "Our estimators handle pricing, so I'm arranging that appointment now. And if you only want a price, they can give you a quick quote without the visit.",
  ],
  schedule_follow_up: [
    "No problem at all. I'll check back in with you later on.",
    "Understood. I'll follow up with you down the line.",
  ],
  bailout: [
    "No problem. I'll leave it there, and reach out any time if things change.",
    "Understood, I won't keep bothering you. We're here if you need us.",
  ],
  transferred: [
    "I'm passing you over to our office now. They'll take it from here.",
  ],
  // — A2, script 1: we cannot tell yet, so buy a moment and hand off —
  //
  // "If the zip does NOT resolve to a Zip_Code__c row, OR its Service
  // Territory is INACTIVE or named 'Out of Area', SAY SOMETHING LIKE: 'Just a
  // moment, I'm checking availability.', then hand off — a human must check
  // with the estimator before any coverage is promised."
  //
  // NEVER NAMES THE CHECK. Kate, 2026-09-10: "Saying anything like 'let me
  // check that zip against our service area' signals we are not local, which
  // costs us the lead even when the answer is yes." Checking availability is
  // what any office does; checking whether you are in our area is not.
  checking_availability: [
    "Just a moment, I'm checking availability.",
    "One moment while I check availability for you.",
  ],

  // — A2, script 2: the project really is in a state we do not cover —
  //
  // "I have [ZIP] on file as the zip code, and unfortunately, we don't
  // currently service the state of [STATE]. Is the project outside of
  // [STATE]?"
  //
  // IT ASKS. The zip on file is often stale, and Kate's own findings include
  // a customer who gave a New Jersey address while FL 33308 sat on the
  // record. Closing on the record's word loses a lead we do cover, so this
  // names what we hold and gives them the chance to correct it.
  //
  // Both values are slots, so the message cannot render without them: naming
  // the wrong state is worse than the old blanket sentence it replaces.
  area_not_serviced: [
    "I have {zip} on file as the zip code, and unfortunately we don't currently service the state of {state}. Is the project outside of {state}?",
    "The zip I have on file is {zip}, and unfortunately we do not currently service {state}. Is the project somewhere other than {state}?",
  ],

  /**
   * ASKED WHETHER THEY ARE TALKING TO A BOT.
   *
   * WORDING NEEDS KATE. This answers without claiming to be a person and
   * without denying anything, because the one thing this message must never
   * do is lie about it — a customer who asks that question directly and is
   * told "yes, a real person" has been deceived, and it is the sort of thing
   * that ends up in a screenshot. It also must not stall: the conversation is
   * already handing to a person, so it says that and stops.
   */
  /**
   * A46 — APPROVED FINAL TEXT, byte for byte.
   *
   * One variant, not two: this is approved copy and rotating it would mean
   * sending something that was never approved. The old pair handed the
   * conversation to a person and ended it, which threw away a live lead for
   * asking a fair question — and neither line answered the question.
   */
  /**
   * The IN-HOURS wording. Out of hours applyDisclosure replaces the whole
   * message with the line that offers nobody — see disclosureMove, which is
   * applied after the renderer. Left as the in-hours default here because
   * this table has no clock and should not grow one: two places deciding the
   * hour is how they come to disagree.
   */
  bot_suspected: [DISCLOSURE_IN_HOURS],

  // — Silent —
  /**
   * KATE'S OWN WORDING, 2026-10-05, replacing ours.
   *
   * Ours invited the customer to correct us: "If I've misread the project,
   * let me know and I'll take another look." She rejected the premise:
   *
   *   "This won't make sense to the customer because they obv don't know our
   *    covered services or they would know we don't do what they're asking"
   *
   * The ask was unanswerable. Only PPP knows where the line is, so inviting
   * the customer to dispute it asks them to argue from information they do
   * not have. Hers puts the doubt on US — "I'll circle back if I'm wrong" —
   * and the conversation goes to a person to confirm, which is what actually
   * happens, in her words "without the customer knowing".
   *
   * Both variants keep her shape: we probably cannot help · we will check ·
   * sorry. Neither asks the customer to do anything. And neither names
   * another company, which is still A18.
   */
  discard: [
    "I don't think we can help with this project but I'll circle back if I'm wrong. Apologies for the inconvenience!",
    "I don't believe this is something we take on, though I'll check and come back to you if that's wrong. Sorry for the trouble!",
  ],
  // Kate's own words, from A17's card. The re-engagement line is the POINT
  // here and the breach on an opt-out; A24 is what keeps the two apart.
  lost: [
    "Understood! We'll be here if things change.",
    // The second variant avoids a phrase Kate banned outright; the tone test
    // reads this file's source rather than rendered output, so a variant at a
    // turn number no test reaches still cannot slip past. It caught mine.
    "Understood, and thanks for the update. We'll be here if things change.",
  ],
  msg_liked_loved: [""],
};

/**
 * How much of a customer's own words we read back.
 *
 * confirm_scope quotes the enquiry, and an enquiry has no length limit — a
 * 5000-character one produced a 5053-character message, which is about 32 SMS
 * segments, costs 32 times as much and is unreadable on a phone. Kate's real
 * example runs to roughly 250 characters, so the cap sits above a genuine
 * scope and well below a pathological one.
 *
 * Truncated at a word boundary, because cutting mid-word reads as a bug to the
 * person receiving it.
 *
 * The trailing "…" is a deliberate, narrow exception to Kate's "avoid
 * ellipsis" rule. That rule is about rapport that trails off — "Okay..." reads
 * as hesitant. A truncation marker is the opposite: it is the clearest way to
 * tell somebody we have shortened their own words rather than misquoted them.
 * It appears ONLY here, never in a template, and template-tone.test.ts checks
 * the templates themselves stay clean.
 */
export const MAX_QUOTED = 180;

export function clip(v: string | null | undefined, max = MAX_QUOTED): string | null {
  const t = (v ?? "").trim();
  if (!t) return null;
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[,;:.\s]+$/, "")}…`;
}

/** Rapport that would collide with the template's own opener. The model likes
 *  to lead with a greeting; the template often does too, and "Hi there! Happy
 *  to help — what's the project?" reads like two people talking. */
const BARE_GREETING = /^(hi|hey|hello|hi there|good morning|good afternoon)[!.,]*$/i;

/**
 * Rapport that acknowledges and says nothing else.
 *
 * "Got it", "Perfect, thanks", "Sorry about that". Fine on their own, and the
 * problem is that half the templates open the same way, so the two stack and
 * the customer gets it twice:
 *
 *     "Got it. Got it. And what's the zip code there?"
 *     "Great, thank you. Perfect, you're all set."
 *     "Sorry about that. Apologies, I did not mean to make this harder."
 *
 * All three came out of walking real conversations through the pipeline and
 * reading them. No test caught any of it, because every assertion was about
 * whether the right WORDS were present and all of them were, twice.
 *
 * Deliberately matches the whole string. "Got it, cabinets are no problem" is
 * an acknowledgement that goes on to say something, and that is worth
 * sending.
 */

/** Does this template already open by acknowledging something? */
/**
 * The optional lead-in matters more than it looks. "That's great news" and
 * "That's great to hear!" both open with an acknowledgement, and without
 * seeing past "That's" neither registered as one — so the customer who
 * accepted a quote was told:
 *
 *   "That's great news, thanks for the go ahead. That's great to hear!
 *    I'll let the office know so they can get you booked in."
 *
 * The same sentiment twice, in consecutive sentences. Found in the simulator
 * on 2026-09-27. longestSharedRun did not catch it either: "That's great" is
 * two words and the echo threshold is four.
 */
const OPENS_WITH_ACKNOWLEDGEMENT =
  /^(?:(?:that|this)(?:'|’)?s\s+|that is\s+|this is\s+)?(?:got it|perfect|great|wonderful|excellent|fantastic|thanks|thank you|understood|no problem|sounds good|okay|ok|sure|absolutely|of course|apologies|sorry|good news|happy to help)\b/i;

/**
 * True when the rapport adds nothing the template is not already saying.
 *
 * Exported because A29 needs the same question answered from the other side:
 * a bare acknowledgement is not an answer to "do you do cabinets?", and
 * treating it as one let the bot ignore a direct question while appearing to
 * respond.
 */
/**
 * How much verbatim overlap makes the rapport a repeat of the template.
 *
 * Four words. Measured against the rapport the model actually writes for
 * these turns: nine of the thirty intents have a template that shares four
 * or more words in a row with a stock opener, and several are exact —
 * "Got it, thank you." in front of a template that says "Got it, thank you.",
 * and "Let me get someone from our team on this." in front of "Let me get one
 * of our team on this."
 *
 * One below the customer-echo threshold on purpose. Repeating OUR OWN
 * sentence back to back in one message is more obviously wrong than sharing a
 * phrase with something the customer said, and costs only a warmer opener.
 */
const TEMPLATE_ECHO_WORDS = 4;

export function rapportIsRedundant(rapport: string, template: string): boolean {
  const said = rapport.trim();
  if (!said) return true;
  // A bare acknowledgement in front of a template that already opens with one.
  if (BARE_ACKNOWLEDGEMENT.test(said) && OPENS_WITH_ACKNOWLEDGEMENT.test(template.trim())) return true;

  /**
   * AND TWO ACKNOWLEDGEMENT OPENERS IN A ROW, whether or not either is bare.
   * The template wins for the reason it always does: it is the half that goes
   * on to say what happens next. freeText is documented as "short rapport
   * only, or empty", so what is lost is the pleasantry, not the substance.
   */
  if (OPENS_WITH_ACKNOWLEDGEMENT.test(said) && OPENS_WITH_ACKNOWLEDGEMENT.test(template.trim())) return true;

  /**
   * AND THE SUBSTANTIVE CASE, WHICH THIS USED TO MISS ENTIRELY.
   *
   * The old test only ever fired on a bare "Got it". Seen in the simulator on
   * the nurture track: "I'll have the estimator confirm exactly what's
   * included." glued to "The estimator will confirm that with you directly."
   * Neither half is an acknowledgement, so nothing caught it, and the
   * customer was told the same thing twice in consecutive sentences.
   *
   * The template wins, because it is the part that goes on to ask the next
   * question and the part nobody can accidentally change.
   */
  if (longestSharedRun(said, template) >= TEMPLATE_ECHO_WORDS) return true;

  /**
   * AND THE SAME ANSWER IN DIFFERENT WORDS.
   *
   * Replaying a thread Hatch had abandoned, the customer asked for a ballpark
   * and got:
   *
   *   "Pricing comes from our estimator once they've looked over the details.
   *    That's one for the estimator, and they'll go through it with you."
   *
   * Two sentences, one fact. Neither is a bare acknowledgement and the longest
   * shared run is "the estimator" — two words, against a threshold of four —
   * so every existing check passed it.
   *
   * Our templates are built around a very small number of nouns: the
   * estimator, the office, the calendar, the quote. When the model's rapport
   * names the SAME one the template does, it is answering a question the
   * template is already answering. The template wins, as everywhere else,
   * because it is the half that goes on to ask the next question.
   *
   * Narrow on purpose: it needs the same noun in both halves. Rapport about
   * the office in front of a template about the calendar is two different
   * things and survives.
   */
  const SUBJECTS_OUR_TEMPLATES_OWN =
    /\b(estimators?|office|calendar|pricing|quotes?)\b/gi;
  const nounsIn = (text: string) =>
    new Set((text.toLowerCase().match(SUBJECTS_OUR_TEMPLATES_OWN) ?? []).map((n) => n.replace(/s$/, "")));
  const inRapport = nounsIn(said);
  if (inRapport.size) {
    for (const noun of nounsIn(template)) {
      if (inRapport.has(noun)) return true;
    }
  }
  return false;
}

/**
 * The opt-out disclosure.
 *
 * PPP's own campaign message carries "Reply END to stop texts." and ours
 * carried nothing at all — the very first thing a stranger receives from an
 * automated system has to tell them how to make it stop. That is a TCPA
 * requirement, not a courtesy, and it was missing from every outbound message
 * this system could produce.
 *
 * STOP rather than END because STOP is the carrier-level standard every
 * handset and aggregator honours. classifyInbound already accepts both, plus
 * QUIT, CANCEL and UNSUBSCRIBE, so nothing a customer reasonably types is
 * missed.
 *
 * FIRST MESSAGE ONLY. Repeating it on every text is what makes a thread read
 * like spam, and the obligation attaches to the start of the conversation.
 */
export const OPT_OUT_DISCLOSURE = "Reply STOP to opt out.";

export type RenderInput = {
  intent: Intent;
  /** The model's rapport, already post-filtered by validateAction. */
  freeText?: string;
  /** Which turn this is — picks the phrasing, so a conversation does not open
   *  with the same sentence every single time. */
  turn?: number;
  /** Photos attached to the customer's message. Acknowledged explicitly:
   *  Hatch cannot see them at all, and ignoring a photo somebody just sent is
   *  the most obvious way to look like a bot. */
  photos?: number;
  /** True when this is the first thing we have ever sent this person, which
   *  is the message that must carry the opt-out disclosure. */
  isFirstOutbound?: boolean;
  /** Values the system holds, for the confirm_* intents to read back. These
   *  are system data, not model output — interpolating them keeps the
   *  guarantee that nothing the model wrote reaches the customer unfiltered. */
  known?: {
    address?: string | null; phone?: string | null; email?: string | null; scope?: string | null;
    /** The zip we hold and the state it resolves to, for A2's out-of-state
     *  message. Both are looked up, never inferred by the model. */
    zip?: string | null; state?: string | null;
  };
  /** What is missing from a partial address. Narrows ask_address to the gap,
   *  which is what A11 requires. See ASK_ADDRESS_GAP below. */
  addressGap?: AddressGap;
  /**
   * Parity gap 6: this ask is about the SECOND property, not the first.
   *
   * Hatch: "Complete the full flow for the first, then repeat for the next."
   * So the ask must name which one, or a customer who has already given one
   * address reads "What's the address for the project?" as us having lost it.
   *
   * The system knows there is a second property and the model does not, so
   * this is a flag rather than another intent — the same reasoning as
   * addressGap. Without it askSecondPropertyAddress() had no caller at all:
   * the validator blocked the close and nothing ever asked the question that
   * would unblock it.
   */
  secondProperty?: boolean;
  /**
   * We have asked for the address already and still hold none of it — so this
   * ask is a REPEAT, and Kate's zip floor applies. See ASK_ADDRESS_REFUSED.
   *
   * A flag rather than something the renderer works out, for the same reason as
   * addressGap and secondProperty: the system knows what it has already sent,
   * and the model does not.
   */
  addressAskedBefore?: boolean;
  /** What is missing from a partial availability. Narrows ask_availability,
   *  which is A4's own remedy. See ASK_AVAILABILITY_GAP below. */
  availabilityGap?: AvailabilityGap;
  /**
   * WHY this customer qualifies for a remote quote on a job that would
   * normally be seen in person. A7 mandates it, and it is the only reason
   * allowed in an ask anywhere in the system. Phrased to follow "but since",
   * e.g. "you're not able to be at the property".
   */
  offsiteReason?: string | null;
  /**
   * What PPP DOES cover, said the way a person would: "interior and exterior
   * painting, cabinets and drywall". Used only when turning work down, so the
   * customer gets a door rather than a wall.
   *
   * Comes from the workspace's own service rows, never a list written here —
   * a hardcoded one drifts from the configuration, which is the mistake that
   * made the bot refuse flooring it actually sells.
   */
  covers?: string | null;
  /** What the customer just said, for the one decision that needs it. */
  customerText?: string | null;
  /**
   * Their EARLIER messages, oldest first.
   *
   * Only for the questions whose answer depends on something said several
   * turns ago rather than in the latest message. Parity 7 is the case: having
   * worked with PPP before is stated once and stays true, so a check reading
   * only customerText never sees it and the acknowledgement never fires.
   */
  customerMessages?: readonly string[];
  /**
   * They have asked US for times twice, and we have no calendar to answer
   * with. Suppresses a trailing "what days work for you?" on the turns that
   * are otherwise correct — see withoutATimingQuestion.
   */
  availabilityStandOff?: boolean;
  /**
   * How far the required flow has actually got, for the new-lead track.
   *
   * Used for one thing: a template that ends by asking about days must not do
   * so before the flow has reached the availability step. The ORDER rule is
   * enforced on flow intents, and defer_to_estimator is not one — so its
   * trailing "what days generally work best on your end?" reached a customer
   * at stage 0, before we had the address or a name, while ask_availability
   * asking the identical thing was refused as out_of_order.
   */
  flowStage?: number;
  /**
   * What WE have already said, oldest first.
   *
   * Only for "have we asked this already". Parity 7 caps its acknowledgement at
   * one, and the only record of having sent it is the outbound message itself.
   */
  botMessages?: readonly string[];
  /** A30 — the language of the CONVERSATION, not of the latest message. */
  language?: Language;
  /** Which conversation this is. A few turns read differently once a quote
   *  has already been sent. See SAYS_NURTURE. */
  track?: "new_lead" | "nurture";
  /**
   * A25's phone branch: when to call, if we already know.
   *
   * Kate, 2026-09-18: "the bot must GATHER THEIR CALLBACK TIME PREFERENCE
   * FIRST if it does not already have it. Ending without capturing when to
   * call is the defect." So a call request with neither of these asks when
   * before it promises anything.
   */
  callback?: {
    /** From A44's reachability parser — "I'm at work until 5". */
    unreachableStartHour?: number | null;
    /** Availability already captured on the record. */
    availability?: string | null;
    /** The clock hour they asked to be called at, if they named one — so a
     *  time nobody is there for can be answered with the hours instead. */
    requestedHour?: number | null;
  };
  /**
   * When it is where the CUSTOMER is, for the availability ask.
   *
   * Hatch offers "this week" Sunday-Wednesday and "next week"
   * Thursday-Saturday. Which side of that cut we are on is their Thursday,
   * not the server's. Absent, the ask falls back to the generic wording
   * rather than guessing a week.
   */
  now?: Date;
  customerZone?: string;
};

/**
 * Asking for only the part of the address we are missing.
 *
 * A11, the most broken critical rule in Kate's grading at 287 breaches: "Ask
 * only for the MISSING part of a partial address." Somebody who has already
 * sent "482 Marchmont Ave" is asked for a zip, not for an address, and the
 * street is read back so it lands as us having it rather than as a second
 * unrelated question.
 *
 * NOT an intent. The model's vocabulary is unchanged: it still chooses
 * ask_address, and the renderer narrows the question to the gap. Widening the
 * enum would give the model two more ways to be wrong in exchange for nothing,
 * since it is the system, not the model, that knows which half is missing.
 *
 * City and state are never asked for. A zip resolves both out of the 2,194
 * rows PPP already curates, and asking somebody to type what we can look up is
 * the complaint this entire family of rules is about.
 */
/**
 * THE LATER ASKS SAY WHY, which is Kate's answer of 2026-10-05 to "after one
 * refusal, does move on mean stop asking?":
 *
 *   "Letting them know we at least need to confirm the zip code to provide an
 *    accurate estimate is valid. We wouldn't be able to provide an in-person
 *    estimate without a confirmed address, so a phone pricing would be
 *    offered/required in this case."
 *
 * So the zip is the floor, not the whole address, and the reason is worth
 * saying out loud: a bare second "what's the zip code there?" reads as
 * nagging, while the same question with "so the estimate is accurate" reads
 * as a reason somebody can agree with.
 *
 * Variants are selected by turn, so the first ask stays short and the repeat
 * carries the reason. Neither is a third ask: A41 still caps it, and
 * validateAction still lets the conversation move past the address once one
 * more attempt has been made — including to phone_pricing, which is exactly
 * the fallback Kate names when no address is ever confirmed.
 */
/**
 * THE ZIP FLOOR, said once and referenced everywhere it is needed.
 *
 * Kate's "we at least need the zip, and here is why" lands in two different
 * places: the third ask when we hold HALF an address, and the second ask when
 * we hold NONE of it because they refused. Same sentence, same rule, so it is
 * one string — the fourth copy of a line is how the wording in one branch gets
 * fixed and the wording in another does not.
 */
export const ASK_ZIP_WITH_REASON =
  "No problem. We at least need the zip code to price it accurately. What's the zip there?";

const ASK_ADDRESS_GAP: Record<"zip" | "street", string[]> = {
  zip: [
    "Thanks! What's the zip code for {address}?",
    "Got it. And what's the zip code there?",
    "No problem. We do need the zip code at least, so the estimate is accurate. What is it?",
  ],
  street: [
    "Thanks! And what's the street address?",
    "Got it. What's the street address there?",
    ASK_ZIP_WITH_REASON,
  ],
};

/**
 * WHEN THEY GAVE US NOTHING AND WE ALREADY ASKED.
 *
 * A refusal is not a partial address, so none of the gap narrowing above
 * applies and ask_address fell through to its ordinary variants — which is how
 * "I'd rather not give my address out over text" was answered with "What
 * address should we have the estimator go to?", the same question again with
 * no reason attached. Kate, 2026-10-05: "Letting them know we at least need to
 * confirm the zip code to provide an accurate estimate is valid."
 *
 * So the re-ask narrows to the zip and says why, exactly as it does for half
 * an address. A41 still caps it at this one more attempt; after that the
 * conversation moves to a phone price.
 */
const ASK_ADDRESS_REFUSED = [ASK_ZIP_WITH_REASON];

/**
 * A PHONE PRICE WHEN WE HAVE NO ADDRESS AT ALL.
 *
 * The ordinary phone_pricing wording says "I'm getting that appointment set up
 * for you… if a number is all you need, they can do a quick quote instead".
 * That is right for the case it was written for — a small job, or somebody who
 * wants a number today — where the visit is the default and the phone quote is
 * the alternative offered.
 *
 * It is a FALSE PROMISE for the customer who just refused to give an address.
 * Played live 2026-10-05: they said "no im not giving that out, i told you",
 * and two turns later the bot said it was setting up their appointment — to a
 * property we cannot locate, which the office cannot send anybody to. It also
 * ignores the thing they just said twice.
 *
 * So the branches swap: here the phone quote is the plan, not the fallback,
 * and no appointment is mentioned because none can happen. Still names no time
 * (A15) and still promises no price (A1).
 */
const PHONE_PRICING_NO_ADDRESS = [
  "That's no problem — we can do this over the phone instead. One of our estimators will call you to go through the details and get you a price.",
  "Not a problem at all. We'll price it over the phone instead, and an estimator will reach out to go through the details with you.",
];

/**
 * Asking for the half of the availability we are missing.
 *
 * A4, Kate, 2026-09-21: "A DAY IS NOT A WINDOW, AND BOTH ARE REQUIRED. 'Wed &
 * Friday this week works best' is NOT availability collected — the estimator
 * cannot be booked against it. THE TEST: could a person reply 'you're booked
 * for X' without asking anything further?" And the remedy, in her words:
 * "Where only a day is given, ask for the window and collection is then
 * complete."
 *
 * Same shape as the address gap, and for the same reason: re-asking the whole
 * question makes somebody repeat the half they already gave.
 *
 * ONLY EVER NARROWS AN ASK THE MODEL HAS ALREADY CHOSEN. It never decides
 * that an ask should happen. That matters because a customer who says "Not
 * today, I will call if I need you" parses as a day with no window, and
 * chasing them for a time window would be the deferral failure A40 describes.
 * The model picks the intent for a deferral; this only changes the wording
 * once ask_availability is the decided move.
 */
const ASK_AVAILABILITY_GAP: Record<"window" | "day", string[]> = {
  window: [
    "What sort of time window works on those days?",
    "And roughly what time of day suits you then?",
  ],
  day: [
    "Which day works best for you?",
    "And what day were you thinking?",
  ],
};

// ASKED_FOR_A_CALL moved to customer-asks.ts: channel-preference.ts needs
// the same question and importing render.ts from there would be a cycle.

/**
 * Does the TEMPLATE for this turn already ask something?
 *
 * The tone filter drops rapport containing "?" as "a second question". That
 * is only true when the template asks the first one. answer_question has no
 * template at all — the model's sentence IS the whole message — so a question
 * in it is the only question there is, and dropping it left the customer's
 * question unanswered and the turn refused.
 *
 * Seen on the nurture track: "does the price include the primer and prep
 * work?" came back question_left_unanswered because the answer was dropped
 * for asking a second question that did not exist.
 *
 * Read from the templates rather than from a list kept somewhere else, so it
 * cannot drift from what is actually sent.
 */
/**
 * WHERE THE NURTURE TRACK NEEDS DIFFERENT WORDS.
 *
 * Most intents read the same on both tracks. defer_to_estimator does not: its
 * new-lead wording ends "in the meantime, what days generally work best on
 * your end?", which is the right next question for somebody who has not been
 * visited yet and the wrong one for somebody holding a quote from an
 * estimator who already came.
 *
 * Seen in the simulator on the nurture track, answering "does the quote
 * include the primer and prep work?" by asking for appointment days.
 *
 * A33 still binds: answer what can be answered, name who answers the rest,
 * and leave the conversation open on a question.
 */
const SAYS_NURTURE: Partial<Record<Intent, string[]>> = {
  defer_to_estimator: [
    "The estimator will confirm that with you directly. Would you like me to have them give you a call?",
    "That's one for the estimator, and they can go through it with you. Shall I ask them to reach out?",
  ],
};

const SAYS_NURTURE_ES: Partial<Record<Intent, string[]>> = {
  defer_to_estimator: [
    "El estimador se lo confirmará directamente. Le pido que lo llame?",
    "Eso lo ve el estimador y puede repasarlo con usted. Quiere que se comunique con usted?",
  ],
};

export function templateAsks(intent: Intent, turn = 0): boolean {
  const variants = SAYS[intent] ?? [""];
  const pick = variants[turn % variants.length] ?? "";
  return pick.includes("?");
}

/**
 * A NAMED TIME IS ACKNOWLEDGED, THEN THE FLOW CARRIES ON.
 *
 * A15's remedy already existed and only fired when the model happened to pick
 * an availability intent. Played in the simulator:
 *
 *   customer  "I need the kitchen and two bedrooms painted. Can you come
 *              Tuesday at 2?"
 *   BOT       "What's the address for the project?"
 *
 * A15 is satisfied — nothing was confirmed, which is the half that costs money
 * — but the customer asked a direct question and got nothing back at all. They
 * will ask again, and a bot that ignores the thing you actually asked about is
 * the complaint A29 is made of.
 *
 * replyToRequestedTime's own comment says what should happen: "Holds the
 * moment without promising it. THE FLOW CARRIES ON AFTER." So it leads, and
 * the collecting question follows in the same message.
 *
 * ONLY THE in_hours LINE, which is a statement. too_early and too_late carry
 * their own question, and prefixing one of those to an ask would put two
 * questions in a message — the A22 breach this codebase already fights. Those
 * still get their full answer when the flow reaches the availability turn.
 */
/**
 * WHAT confirm_scope MAY READ BACK.
 *
 * The scope is the customer's own typing, kept whole — so a first message like
 * "I need the kitchen and two bedrooms painted. Can you come Tuesday at 2?"
 * became, verbatim:
 *
 *   "Just to confirm, you're looking for: I need the kitchen and two bedrooms
 *    painted. Can you come Tuesday at 2?. Is that right?"
 *
 * "Just to confirm" sitting next to "Tuesday at 2" is how a customer concludes
 * the appointment is booked, which is the exact harm A15 exists to prevent —
 * and the bot never agreed to anything. Caught by the scenario sweep's "no
 * reply names a day" check on a scenario added the same afternoon.
 *
 * Clauses naming a DAY or a CLOCK TIME are dropped, and nothing else is
 * touched: the project words are the customer's and they should hear their own
 * description back. Returns "" when that leaves nothing to confirm, which
 * renders no message and hands the turn to a person — the right outcome when
 * the only thing we could read back is an appointment request.
 */
const NAMES_A_DAY_OR_TIME =
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight)\b|\b\d{1,2}\s*(?:am|pm)\b|\b(?:at|around)\s+\d{1,2}(?::\d{2})?\b/i;

export function scopeForReadback(scope: string | null | undefined): string {
  const t = (scope ?? "").trim();
  if (!t) return "";
  const kept = t
    .split(/(?<=[.?!])\s+/)
    .filter((sentence) => sentence.trim() && !NAMES_A_DAY_OR_TIME.test(sentence))
    .join(" ")
    .trim();
  return kept;
}

/** Shared with the A29 guard — see TIME_IS_ACKNOWLEDGED_BY. */
const ACKNOWLEDGES_A_TIME = TIME_IS_ACKNOWLEDGED_BY;

/** MINE, NOT KATE'S — an unapproved translation, like A46's Spanish. See
 *  docs/QUESTIONS_FOR_KATE.md item 9. */
const CHECKING_THE_CALENDAR_ES = "Voy a revisar el calendario para esa hora.";

/**
 * A THIRD ASK, AFTER THEY HAVE TWICE ASKED US.
 *
 * Hatch: "If they insist on knowing our availability before providing theirs,
 * End: Schedule Follow Up." The validator refuses ask_availability once
 * isAvailabilityStandOff is true — but the QUESTION leaks through other
 * templates. Seen in the simulator on 2026-09-27, after the customer had
 * asked twice:
 *
 *   BOT  "That's one for the estimator, and they'll go through it with you.
 *         What days suit you best?"
 *
 * defer_to_estimator is the RIGHT intent — the estimator does own the
 * calendar, and refusing it would strand the turn — so the intent stays and
 * the trailing ask goes. What is left still answers them.
 *
 * Only a trailing question, and only one about days or times: the rest of the
 * message is the answer and must survive. If stripping would leave nothing,
 * the original stands, because a silent turn is worse than a third ask.
 */
const ASKS_ABOUT_TIMING =
  /\b(?:days?|times?|window|weekday|weekend|availability|available|suits?|easiest|work best|works best)\b/i;

function withoutATimingQuestion(body: string): string {
  const sentences = body.split(/(?<=[.?!])\s+/);
  const last = sentences[sentences.length - 1] ?? "";
  if (!last.includes("?") || !ASKS_ABOUT_TIMING.test(last)) return body;
  const kept = sentences.slice(0, -1).join(" ").trim();
  return kept || body;
}

/** Availability is the fourth leg, so it is due only once three are done. */
const AVAILABILITY_STEP = 3;

export function renderMessage(input: RenderInput): string {
  /**
   * Two reasons to drop a trailing question about days, and they are the same
   * defect seen twice: a rule enforced per-INTENT, walked round by another
   * intent's TEMPLATE.
   *
   *   the stand-off — they have asked US twice, so nothing asks them again
   *   the order     — availability is step four and this is not step four yet
   */
  const tooEarlyToAskAboutDays =
    input.track !== "nurture"
    && input.flowStage !== undefined
    && input.flowStage < AVAILABILITY_STEP;
  /**
   * EXCEPT WHEN THE QUESTION IS "WHEN MAY WE PHONE YOU", WHICH IS NOT THIS.
   *
   * Both guards above exist to stop the bot asking for APPOINTMENT
   * availability — the fourth leg — too early or too often. A25's callback
   * question is a different question with the same vocabulary: it asks when
   * to place a CALL, it is required the moment somebody asks to be phoned,
   * and it has nothing to do with where the booking flow has got to.
   *
   * Caught live, not by a test. "Could you please call me instead of
   * texting, around 11pm works" on turn one rendered
   *
   *   "We make calls between 9am and 8pm. Is there a time in there that
   *    works for you?"
   *
   * and the stripper took the second sentence, because flowStage was 0 and
   * the sentence says "time". That leaves the customer holding our opening
   * hours with nothing asked of them — exactly half of what Kate specified:
   * "state business hours + ask if there is a time that works for them
   * within that timeframe."
   *
   * The sibling branch escaped by luck rather than design: "What's a good
   * time to reach you?" is a single sentence, so stripping it would leave
   * nothing and the fallback puts it back.
   */
  const isCallbackQuestion =
    input.intent === "schedule_follow_up"
    && ASKED_FOR_A_CALL.test(input.customerText ?? "");
  const body = (input.availabilityStandOff || tooEarlyToAskAboutDays) && !isCallbackQuestion
    ? withoutATimingQuestion(renderBody(input))
    : renderBody(input);
  if (!body || !ACKNOWLEDGES_A_TIME.has(input.intent)) return body;
  const timed = replyToRequestedTime(input.customerText);
  if (!timed || timed.verdict !== "in_hours") return body;
  const lead = input.language === "es" ? CHECKING_THE_CALENDAR_ES : timed.reply;
  // Already talking about the calendar? Do not say it twice.
  if (/calendar|calendario/i.test(body)) return body;
  const withLead = `${lead} ${body}`;
  /**
   * A22 OUTRANKS THE COURTESY. confirm_address reads back an address and asks
   * about it; adding a sentence about the calendar tipped it over the one-ask
   * limit — "asks the customer to produce 3 things at once (address,
   * availability, scope)". Caught by running tooManyAsks over the result
   * rather than by reasoning about which intents were safe.
   *
   * An acknowledgement that breaks a rule is worse than no acknowledgement:
   * the time still gets its full answer at the availability turn.
   */
  return tooManyAsks(withLead) ? body : withLead;
}

function renderBody(input: RenderInput): string {
  // A partial address narrows the question before anything else happens.
  // "both" missing is the ordinary ask, which is already the right question.
  const gap = input.intent === "ask_address" && (input.addressGap === "zip" || input.addressGap === "street")
    ? input.addressGap
    : null;
  // Same idea for availability: they named days but no window, or a time but
  // no day, so ask for the missing half rather than the whole question.
  const availGap = input.intent === "ask_availability"
    && (input.availabilityGap === "window" || input.availabilityGap === "day")
    ? input.availabilityGap
    : null;
  // A30: reply in the customer's language. One table or the other, chosen
  // once here, so a message can never come out half in each — which is the
  // failure that started this: "Hola! Con gusto le ayudo. What are you
  // looking to have painted?"
  const es = input.language === "es";
  /**
   * Parity gap 6. A second-property ask names which property, and it beats the
   * ordinary ask_address wording — but NOT the A11 gap wording, which is why
   * this is checked after `gap`: somebody who gave "44 Elm Ave" with no zip is
   * asked for the zip, second property or not. Asking "what's the address for
   * the second property?" when we already have half of it is the A11 breach
   * that gap narrowing exists to prevent.
   */
  const secondProperty = input.intent === "ask_address" && !gap && !!input.secondProperty;
  /**
   * A re-ask after a refusal. Checked after `gap` and `secondProperty` for the
   * same reason they are ordered that way: holding half an address, or being on
   * the second property, is the more specific fact and keeps its own wording.
   */
  const refused = input.intent === "ask_address" && !gap && !secondProperty
    && !!input.addressAskedBefore;
  /**
   * No flag for this one: the renderer already holds the address, so it can
   * see for itself that there is none. Derived beats passed — a flag would be
   * a fourth thing two callers have to remember to set.
   */
  const phonePriceNoAddress = input.intent === "phone_pricing" && !input.known?.address;
  const variants = secondProperty
    ? [es ? askSecondPropertyAddressEs() : askSecondPropertyAddress()]
    : phonePriceNoAddress
    ? (es ? PHONE_PRICING_NO_ADDRESS_ES : PHONE_PRICING_NO_ADDRESS)
    : refused
    ? (es ? ASK_ADDRESS_REFUSED_ES : ASK_ADDRESS_REFUSED)
    : gap
    ? (es ? ASK_ADDRESS_GAP_ES : ASK_ADDRESS_GAP)[gap]
    : availGap
      ? (es ? ASK_AVAILABILITY_GAP_ES : ASK_AVAILABILITY_GAP)[availGap]
      : (input.track === "nurture"
          ? (es ? SAYS_NURTURE_ES : SAYS_NURTURE)[input.intent]
          : undefined)
        ?? (es ? SAYS_ES : SAYS)[input.intent]
        ?? [""];
  let pick = variants[(input.turn ?? 0) % variants.length] ?? "";

  // Substitute verified values. A template whose value is missing must not go
  // out with "{address}" in it — validateAction refuses that intent, but the
  // renderer is the last line and says nothing rather than something broken.
  if (pick.includes("{")) {
    const v: Record<string, string | null | undefined> = {
      // Address, phone and email are bounded by their own formats. Scope is
      // whatever the customer typed into a web form.
      address: clip(input.known?.address, 120),
      phone: input.known?.phone,
      email: input.known?.email,
      /**
       * READ BACK WITHOUT THE APPOINTMENT REQUEST. See scopeForReadback: the
       * scope is the customer's whole message, so "…painted. Can you come
       * Tuesday at 2?" was being confirmed back at them under the words "Just
       * to confirm". Empty leaves the slot unfilled, which makes the template
       * refuse to render and hands the turn to a person — correct when the
       * only thing left to confirm was a time we never agreed to.
       */
      scope: clip(scopeForReadback(input.known?.scope)) || null,
      // A7's mandated reason, from the qualifier the SYSTEM matched. Never
      // model text: a reason the bot invented for departing from the normal
      // route is worse than no reason at all. A missing one makes the whole
      // template refuse to render, which is correct — A7 without its reason
      // is just A6 said in the wrong situation.
      reason: input.offsiteReason ?? null,
      // A2 names the zip we hold and the state it is in. Both are system
      // values; a state the model guessed would be worse than saying nothing.
      zip: input.known?.zip ?? null,
      state: input.known?.state ?? null,
    };
    let missing = false;
    pick = pick.replace(/\{(\w+)\}/g, (_m: string, key: string, offset: number, whole: string) => {
      const val = v[key];
      if (!val) { missing = true; return ""; }
      // THE TEMPLATE'S PUNCTUATION WINS.
      //
      // "Just to confirm, you're looking for: {scope}. Is that right?" with a
      // scope that ends in a full stop rendered "...two bathrooms.. Is that
      // right?" to the customer. Inquiry Notes is somebody's typing, so it
      // ends however they left it, and every slot followed by punctuation has
      // the same problem — this is fixed at the seam rather than per template.
      const next = whole[offset + _m.length];
      return next && /[.,;:!?]/.test(next) ? val.replace(/[.,;:]+$/, "") : val;
    });
    if (missing) return "";
  }

  if (isSilent(input)) return "";

  /**
   * THEY ASKED FOR A CALL, SO SAY SOMEBODY WILL CALL.
   *
   * schedule_follow_up covers two situations the guide names together: "they
   * asked to be CALLED, or to be contacted later." The template answered both
   * with "I'll check back in with you later on", so a customer who asked for
   * a phone call was told they would get another text. Seen in the simulator
   * playing "please have someone call me".
   *
   * Read from their own words, never guessed: no call is promised unless they
   * asked for one. No time is named, because nothing here knows the schedule.
   */
  /**
   * THEY NAMED A TIME — HOLD IT, NEVER CONFIRM IT.
   *
   * Hatch parity gap 2, and the likeliest A15 breach in the system. A
   * customer says "Tuesday at 2?" and the natural, helpful reply is "Tuesday
   * at 2 works!" — which invents an appointment nobody booked. A15 already
   * REFUSES that at the validator; what was missing was the right thing to
   * say instead, so the model was left choosing.
   *
   * Placed on the availability turns only. A time mentioned while giving an
   * address is not a request to be booked, and answering one there would
   * derail the flow.
   *
   * Never restates the time. Hatch says it twice — "Do not restate or confirm
   * their time", "Don't thank them" — because repeating it back reads as
   * agreement.
   */
  /**
   * A RETURNING CUSTOMER WHO WOULD RATHER NOT REPEAT THEMSELVES.
   *
   * Hatch: thank them for the NEW project, say why we ask, then ONE ask —
   * "but move on if they don't provide it." A bot that keeps asking is the
   * A11/A13 nag aimed at the customer most likely to buy again.
   *
   * On the collecting turns only, and only when they have said both that
   * they have used PPP before AND that they would rather not repeat
   * themselves. Merely mentioning a past job is not a refusal.
   */
  if (
    (input.intent === "ask_address" || input.intent === "ask_contact" || input.intent === "confirm_address")
    /**
     * OVER THE THREAD, not over the latest message. Both halves in one message
     * is why this never fired: a real customer says "we used you before" on one
     * turn and "you already have it" three turns later, and neither message
     * carries both. See returningCustomerDecliningInThread.
     */
    && returningCustomerDecliningInThread({
      earlier: input.customerMessages ?? [],
      latest: input.customerText,
    })
    /**
     * "ASK IF THEY'D MIND CONFIRMING THEIR ADDRESS, BUT MOVE ON IF THEY DON'T
     * PROVIDE IT." — Hatch, verbatim.
     *
     * ONCE. A customer who refuses twice was getting this same paragraph twice,
     * which is the nag the rule exists to prevent, delivered in the words of an
     * apology for nagging. alreadyAskedToConfirm was written for exactly this
     * and had no caller anywhere, so nothing enforced the "once".
     *
     * Second time through it falls to the ordinary template — one plain ask,
     * which is what A3 requires of the leg. Whether the flow should instead be
     * forced PAST the address leg entirely is a change to what the bot
     * collects, so it is a question for Kate rather than a guess here.
     */
    && !alreadyAskedToConfirm(
      [...(input.customerMessages ?? []), input.customerText ?? ""],
      input.botMessages ?? []
    )
  ) {
    return es ? returningCustomerReplyEs() : returningCustomerReply();
  }

  if (input.intent === "ask_availability" || input.intent === "checking_availability") {
    const timed = replyToRequestedTime(input.customerText);
    if (timed) return timed.reply;
  }

  /**
   * THE AVAILABILITY ASK NAMES A WEEK.
   *
   * Hatch: "this week" Sunday-Wednesday, "next week" Thursday-Saturday. Ours
   * asked "What days generally work best for you?", an open question that
   * invites "sometime next month".
   *
   * Only when the gap is the whole question — availabilityGap narrows a
   * PARTIAL answer ("Tuesday, but what time?") and that wording is already
   * right. And only with a zone and a clock: without them we cannot know
   * which side of their Thursday we are on, and the generic ask is the
   * honest fallback.
   */
  if (input.intent === "ask_availability" && !availGap && input.now && input.customerZone) {
    const week = weekToOffer(input.now, input.customerZone);
    if (week) return es ? askAvailabilityEs(week) : askAvailability(week);
  }

  if (input.intent === "schedule_follow_up" && ASKED_FOR_A_CALL.test(input.customerText ?? "")) {
    const es = input.language === "es";

    /**
     * A25 — CAPTURE WHEN TO CALL BEFORE ENDING.
     *
     * Kate, 2026-09-18: "The bot cannot make a call, so a customer who wants
     * to speak is handed to a human — and the bot must GATHER THEIR CALLBACK
     * TIME PREFERENCE FIRST if it does not already have it. Ending without
     * capturing when to call is the defect."
     *
     * Before this the template promised a call and stopped, so a person
     * picking the conversation up had a phone number and no idea when to use
     * it. Asked only when we hold neither a stated reachability constraint
     * nor captured availability — asking somebody who already told us would
     * be an A11 redundant ask.
     */
    if (phoneBranch(input.callback ?? {}) === "ask_callback_time") {
      const asks = es
        ? [
            "Claro que sí. A qué hora le viene bien que lo llamemos?",
            "Por supuesto. Cuál es el mejor momento para llamarle?",
          ]
        : [
            "No problem at all. What's a good time to reach you?",
            "Of course. When's the best time to give you a call?",
          ];
      return asks[(input.turn ?? 0) % asks.length];
    }

    /**
     * A TIME NOBODY IS THERE FOR IS NOT A CAPTURED TIME.
     *
     * Kate, 2026-09-28: "if call back time is outside of business hours,
     * state business hours + ask if there is a time that works for them
     * within that timeframe."
     *
     * The hours come from CALLBACK_WINDOW rather than being typed in, so this
     * sentence cannot drift from the window the branch actually tests.
     */
    if (phoneBranch(input.callback ?? {}) === "callback_outside_hours") {
      const from = clockHour(CALLBACK_WINDOW.startHour, es);
      const to = clockHour(CALLBACK_WINDOW.endHour, es);
      return es
        ? `Llamamos entre las ${from} y las ${to}. Hay alguna hora dentro de ese horario que le venga bien?`
        : `We make calls between ${from} and ${to}. Is there a time in there that works for you?`;
    }

    /**
     * ONE VOICE, NOT A NARRATED HANDOFF.
     *
     * These read "I'll have someone from the office give you a call" and
     * "I'll get someone on our team to call you instead."
     *
     * Kate, 2026-09-28: "we essentially don't want the bot to say 'I'll have
     * a colleague/human reach out then'. We want it to be a seamless
     * transition" — and the valid reply is "'We will reach out then' or
     * something similar."
     *
     * This is NOT the concealment HANDOFF_MAY_BE_VISIBLE rules out. Nothing
     * here hides that a person takes over, and a person openly does. It is
     * the difference between the business answering and the bot describing
     * its own plumbing, which is a seam the customer has no use for. We read
     * "concealing is not required" as licence to narrate it; that was our
     * mistake rather than hers.
     */
    const variants = es
      ? [
          "Claro que sí. Lo llamamos entonces.",
          "Por supuesto. Nos comunicamos con usted a esa hora.",
        ]
      : [
          "No problem at all. We'll reach out then.",
          "Of course. We'll give you a call then.",
        ];
    return variants[(input.turn ?? 0) % variants.length];
  }

  /**
   * TURNING WORK DOWN SHOULD LEAVE A DOOR OPEN.
   *
   * Karan: "it shouldnt be blocked, it should answer with like We dont
   * provide furniture painting in your area. We offer..."
   *
   * A18 forbids pointing at ANOTHER COMPANY — "say so plainly and stop
   * there". Naming our OWN work is not that, and A8 is the reason it matters
   * here: built-in bookcases and shelving ARE covered, only standalone
   * furniture is not. A customer told "we don't do that" walks away; a
   * customer told what we do cover can say "oh, mine are built in".
   *
   * The list is the workspace's own, so it cannot drift from what the bot
   * was told it sells two paragraphs earlier in the same prompt.
   */
  if (input.intent === "discard" && input.covers) {
    // No em dash. A23 bans it, and it is the one Kate names first — the
    // house-voice test would have caught this in a template, but this string
    // is built in code, so it would have gone out.
    /*
      KATE'S ENDING, 2026-10-05, AND IT HAD TO BE CHANGED IN THREE PLACES.

      The SAYS templates carry her new wording; this branch builds its own
      sentence, so changing the templates left the old "if I've misread the
      project, let me know" alive wherever a workspace has a services list —
      which is every real one. Caught by replaying the furniture scenario in
      the sandbox after shipping the template change, not by the suite: no
      test exercised discard WITH covers.

      Her reason, which this branch has to honour too: the customer does not
      know what we cover, so asking them to judge whether we misread it is
      asking an unanswerable question. The doubt is ours and we come back to
      them. The covers list stays, because that is this branch's whole point
      — "built-in bookcases ARE covered" is what lets somebody say "oh, mine
      are built in".
    */
    if (es) {
      const aperture = (input.turn ?? 0) % 2 === 0
        ? "Creo que no podemos ayudar con este proyecto."
        : "No creo que esto sea algo que hagamos.";
      return `${aperture} S\u00ed cubrimos ${input.covers}. Lo reviso y le aviso si me equivoco. Disculpe la molestia!`;
    }
    const opener = (input.turn ?? 0) % 2 === 0
      ? "I don't think we can help with this project."
      : "I don't believe this is something we take on.";
    return `${opener} We do cover ${input.covers}. I'll circle back if I'm wrong. Apologies for the inconvenience!`;
  }

  const rapport = (input.freeText ?? "").trim();
  const parts: string[] = [];
  /** Where the model's rapport ended up, or -1 when it was not used at all. */
  let rapportAt = -1;

  if (input.photos && input.photos > 0) {
    // A26 in the customer's language, same as everything else.
    parts.push(es
      ? (input.photos === 1 ? "\u00a1Gracias por la foto!" : "\u00a1Gracias por las fotos!")
      : (input.photos === 1 ? "Thanks for the photo!" : "Thanks for the photos!"));
  }

  // answer_question has no template of its own — the model's filtered rapport
  // IS the answer there, which is why it is the one intent allowed to carry
  // the whole message.
  if (
    rapport
    && !BARE_GREETING.test(rapport)
    && !(parts.length && /^thanks/i.test(rapport))
    // Two acknowledgements in a row is how "Got it. Got it." reaches a
    // customer. The template's own opener wins, because it is the one that
    // goes on to say something.
    && !rapportIsRedundant(rapport, pick)
  ) {
    parts.push(rapport);
    rapportAt = parts.length - 1;
  }
  /**
   * AND THE MIRROR CASE: A BARE TEMPLATE AFTER SUBSTANTIVE RAPPORT.
   *
   * rapportIsRedundant catches a bare "Got it" in front of a template that
   * already opens with one. It could not catch the reverse, and the reverse is
   * what a customer actually saw when they parked:
   *
   *   "No rush at all, take your time with that. Got it, thank you."
   *
   * The rapport carries the whole message and the template repeats it as an
   * afterthought. Same shape as "Text works. Sure thing." on the off-site
   * turn. Two acknowledgements stacked is the tell of a machine.
   *
   * The template usually wins — it is the half that goes on to ask the next
   * question and the half nobody can accidentally change. A bare
   * acknowledgement does neither, so here the rapport wins. Rapport is already
   * post-filtered for prices, times and commitments, and it only reaches this
   * branch when it is NOT itself a bare acknowledgement.
   */
  const templateAddsNothing = rapportAt >= 0 && BARE_ACKNOWLEDGEMENT.test(pick.trim());
  if (pick && !templateAddsNothing) parts.push(pick);

  let body = parts.join(" ").replace(/\s+/g, " ").trim();

  /**
   * A22, AT LAST ACTUALLY ENFORCED.
   *
   * one-ask.ts was written with ten tests and never imported by anything, so
   * the rule it implements was not applied to a single outgoing message. The
   * count only means something on the WHOLE message: the template asks for one
   * thing, the model's rapport can quietly ask for two more, and neither half
   * is over the line on its own.
   *
   * Dropping the rapport rather than refusing the turn, which is what a style
   * breach already does here. The template still carries the ask, the
   * conversation still moves, and the part that broke the rule is simply not
   * sent. If the TEMPLATE alone is over the limit that is a template bug and
   * dropping rapport cannot fix it, so the message goes as written and the
   * template tests are where that gets caught.
   */
  if (rapportAt >= 0 && tooManyAsks(body)) {
    const withoutRapport = parts.filter((_, i) => i !== rapportAt)
      .join(" ").replace(/\s+/g, " ").trim();
    if (!tooManyAsks(withoutRapport)) body = withoutRapport;
  }
  // Nothing to say means nothing to send, and a disclosure on its own is not a
  // message — appending it to an empty body would turn a dropped turn into a
  // bare "Reply STOP to opt out."
  if (!body) return "";

  return input.isFirstOutbound ? `${body} ${OPT_OUT_DISCLOSURE}` : body;
}
