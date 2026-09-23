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
import type { Intent } from "./agent-output";
import type { AddressGap } from "./address";
import type { AvailabilityGap } from "./availability";

/** Intents that END the conversation without sending anything. Sending a
 *  cheerful sign-off to somebody who asked to be left alone is how a
 *  complaint starts. */
export const SILENT_INTENTS: ReadonlySet<Intent> = new Set<Intent>([
  "discard", "lost", "bot_suspected", "msg_liked_loved",
]);

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
  phone_pricing: [
    "Pricing is something our estimator goes over with you directly, so I'll have someone reach out to talk it through.",
    "I'm not able to give numbers over text. Our estimator handles that, and I'll get someone to call you.",
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
  area_not_serviced: [
    "Unfortunately that's outside the area we cover, so we won't be able to help on this one. Sorry about that!",
  ],

  // — Silent —
  discard: [""],
  lost: [""],
  bot_suspected: [""],
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
  known?: { address?: string | null; phone?: string | null; email?: string | null; scope?: string | null };
  /** What is missing from a partial address. Narrows ask_address to the gap,
   *  which is what A11 requires. See ASK_ADDRESS_GAP below. */
  addressGap?: AddressGap;
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
const ASK_ADDRESS_GAP: Record<"zip" | "street", string[]> = {
  zip: [
    "Thanks! What's the zip code for {address}?",
    "Got it. And what's the zip code there?",
  ],
  street: [
    "Thanks! And what's the street address?",
    "Got it. What's the street address there?",
  ],
};

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

export function renderMessage(input: RenderInput): string {
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
  const variants = gap
    ? ASK_ADDRESS_GAP[gap]
    : availGap
      ? ASK_AVAILABILITY_GAP[availGap]
      : SAYS[input.intent] ?? [""];
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
      scope: clip(input.known?.scope),
      // A7's mandated reason, from the qualifier the SYSTEM matched. Never
      // model text: a reason the bot invented for departing from the normal
      // route is worse than no reason at all. A missing one makes the whole
      // template refuse to render, which is correct — A7 without its reason
      // is just A6 said in the wrong situation.
      reason: input.offsiteReason ?? null,
    };
    let missing = false;
    pick = pick.replace(/\{(\w+)\}/g, (_m, key: string) => {
      const val = v[key];
      if (!val) { missing = true; return ""; }
      return val;
    });
    if (missing) return "";
  }

  if (SILENT_INTENTS.has(input.intent)) return "";

  const rapport = (input.freeText ?? "").trim();
  const parts: string[] = [];

  if (input.photos && input.photos > 0) {
    parts.push(input.photos === 1 ? "Thanks for the photo!" : "Thanks for the photos!");
  }

  // answer_question has no template of its own — the model's filtered rapport
  // IS the answer there, which is why it is the one intent allowed to carry
  // the whole message.
  if (rapport && !BARE_GREETING.test(rapport) && !(parts.length && /^thanks/i.test(rapport))) {
    parts.push(rapport);
  }
  if (pick) parts.push(pick);

  const body = parts.join(" ").replace(/\s+/g, " ").trim();
  // Nothing to say means nothing to send, and a disclosure on its own is not a
  // message — appending it to an empty body would turn a dropped turn into a
  // bare "Reply STOP to opt out."
  if (!body) return "";

  return input.isFirstOutbound ? `${body} ${OPT_OUT_DISCLOSURE}` : body;
}
