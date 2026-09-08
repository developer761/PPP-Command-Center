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
const SAYS: Record<Intent, string[]> = {
  // — Collecting, in the required order —
  ask_project_details: [
    "What are you looking to have painted?",
    "Happy to help — what's the project you're looking to get done?",
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
    "Can I grab your name and email for the write-up?",
  ],
  ask_availability: [
    "What days generally work best for you?",
    "Are weekdays or weekends easier on your end?",
    "What sort of days work for you to have someone take a look?",
  ],

  // — Keeping it moving —
  // Never empty. An acknowledge that renders to "" is a turn where the
  // customer said something and got silence back — the test caught this on the
  // first run, with an empty first variant.
  acknowledge: ["Got it, thank you.", "Perfect, thanks.", "Great, thank you."],
  answer_question: [""],
  offer_offsite_quote: [
    "Since you're not able to be at the property, we can put together an off-site quote from photos and measurements instead — would that work?",
    "No problem — we can do this as an off-site quote using photos rather than a visit. Want to go that route?",
  ],
  escalate: [
    "Let me get one of our team on this — someone will follow up with you shortly.",
    "I'll pass this to our office so somebody can help properly. They'll be in touch soon.",
  ],

  // — Endings that still say something —
  success: [
    "Perfect — you're all set. Someone from the office will confirm the details with you.",
    "Great, that's everything we need. The office will be in touch to confirm.",
  ],
  phone_pricing: [
    "Pricing is something our estimator goes over with you directly, so I'll have someone reach out to talk it through.",
    "I'm not able to give numbers over text — our estimator handles that. I'll get someone to call you.",
  ],
  schedule_follow_up: [
    "No problem at all — I'll check back in with you later on.",
    "Understood. I'll follow up with you down the line.",
  ],
  bailout: [
    "No problem — I'll leave it there. Reach out any time if things change.",
    "Understood, I won't keep bothering you. We're here if you need us.",
  ],
  transferred: [
    "I'm passing you over to our office now — they'll take it from here.",
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

/** Rapport that would collide with the template's own opener. The model likes
 *  to lead with a greeting; the template often does too, and "Hi there! Happy
 *  to help — what's the project?" reads like two people talking. */
const BARE_GREETING = /^(hi|hey|hello|hi there|good morning|good afternoon)[!.,]*$/i;

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
};

export function renderMessage(input: RenderInput): string {
  const variants = SAYS[input.intent] ?? [""];
  const pick = variants[(input.turn ?? 0) % variants.length] ?? "";

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

  // An answer_question with nothing to say is a dropped turn, not a message.
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
