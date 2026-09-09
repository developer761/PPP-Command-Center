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
    "Can I grab your name and email for the write-up?",
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
  offer_offsite_quote: [
    "Since you're not able to be at the property, we can put together an off-site quote from photos and measurements instead. Would that work?",
    "No problem, we can do this as an off-site quote using photos rather than a visit. Want to go that route?",
  ],
  escalate: [
    "Let me get one of our team on this. Someone will follow up with you shortly.",
    "I'll pass this to our office so somebody can help properly. They'll be in touch soon.",
  ],

  // — Nurture: the quote is out, the job is a decision —
  // Wording adapted from PPP's live Quote Sent campaign rather than invented.
  // No name or estimator is interpolated: those would be slots, and a template
  // that greets the wrong person by name is worse than one that greets nobody.
  nurture_check_in: [
    "Hope all is well! Just a friendly check-in to see whether you had any questions about the quote we sent over, or have made any decisions yet. Let us know when you get a chance.",
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
};

export function renderMessage(input: RenderInput): string {
  const variants = SAYS[input.intent] ?? [""];
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
