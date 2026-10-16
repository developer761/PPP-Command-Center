import { scopeAndStage, scopeFromCustomer } from "./scope";
import { addressFromCustomer } from "./address";
import { emailFromCustomer } from "./email-from-customer";
import { normalizeInbound } from "./inbound-normalize";

/**
 * What we know about this customer, from the record AND from what they said.
 *
 * ── WHY THIS IS ONE FUNCTION ────────────────────────────────────────────
 *
 * The live scheduler and the simulator each have to answer the same question
 * before a turn runs: what do we hold. They answered it separately, and they
 * drifted apart FOUR times in one day, every time in the same direction —
 * the sandbox knowing less than production and refusing turns production
 * answers:
 *
 *   1. the flow stage, so the simulator deadlocked on an opening message
 *      that described the whole job
 *   2. the scope, so confirm_scope and the discard that turns work down in
 *      words came out silent in the sandbox and spoke in production
 *   3. the address, so the sandbox refused the turn as
 *      commitment_in_free_text while production went on to confirm it
 *   4. and each fix had to be made twice
 *
 * simulator.ts already carries the comment that explains why that matters:
 * "a bot that behaves differently in the sandbox than in production is a bot
 * nobody has actually tested". So the derivation lives here and both callers
 * take it whole.
 *
 * ── THE RECORD WINS ─────────────────────────────────────────────────────
 *
 * Anything already on file is the office's version and is never overwritten
 * by something read out of the chat. This only fills in what is missing.
 */
export type OnFile = {
  inquiryScope?: string | null;
  address?: string | null;
  /** What the office holds. Never overwritten by anything read from a text. */
  email?: string | null;
};

/** One inbound, exactly as it arrived. */
export type CustomerMessage = { body: string; mediaCount?: number };

export type KnownFromThread = {
  /** The scope to use this turn, from the record or from their own words. */
  inquiryScope: string | null;
  /** Where it came from, because a customer-sourced scope is persisted and a
   *  record-sourced one must not be rewritten. */
  scopeFrom: "record" | "customer" | null;
  /** The address to use this turn. Partial is kept: A11 needs the gap. */
  address: string | null;
  /** True when the address came from the chat, so the caller knows to store it. */
  addressFromChat: boolean;
  /** The email to use this turn, from the record or from their own words. */
  email: string | null;
  /** True when the email came from the chat, so the caller knows to store it. */
  emailFromChat: boolean;
  /** The flow stage, raised when the customer has already described the job. */
  stage: number;
};

export function knownFromThread(input: {
  onFile: OnFile;
  /** Every customer message in the thread, oldest first, INCLUDING the latest. */
  messages: CustomerMessage[];
  /** The stage from the bot's own past intents, which this may raise. */
  stage: number;
}): KnownFromThread {
  const { onFile, messages, stage } = input;
  const latest = messages[messages.length - 1];

  /**
   * The stage floor comes from the NEWEST message — that is the turn being
   * decided. The SCOPE does not, and reading it from the newest message alone
   * was a bug.
   *
   * WHAT IT DID. A customer says "how much for a 12x14 bedroom?", the bot
   * routes the job and asks a question, they answer "text is fine" — and the
   * scope evaporated, because the newest message has no project in it. Stage
   * fell back to 0, A13's held-field guard had nothing to guard, and the bot
   * asked "What are you hoping to have painted?" about the bedroom it had
   * just quoted. Caught in the simulator on 2026-09-27; "ok" and "yes please"
   * do it too, which is most second messages a customer sends.
   *
   * The file already knew better one line down: the ADDRESS is scanned across
   * the whole thread because it "can have arrived at ANY point". A project
   * description is exactly as durable — it does not stop being true because
   * the next message was "ok".
   *
   * Production was shielded by accident: scheduler-db persists inquiry_scope
   * to the conversation row, so `onFile` carries it on later turns. The
   * SIMULATOR has no row, so it diverged — and this file exists precisely
   * because those two drifting apart is the recurring failure here.
   *
   * THE OLDEST match wins, not the newest, to match how production stores it:
   * `.update({ inquiry_scope }).is("inquiry_scope", null)` writes once and
   * never overwrites. A sandbox that preferred the newest would disagree with
   * the row every time a customer described the job twice.
   */
  const fromLatest = scopeAndStage({
    stage,
    onFile: onFile.inquiryScope,
    rawInbound: latest?.body ?? "",
    mediaCount: latest?.mediaCount ?? 0,
  });
  let scope = fromLatest;
  if (!fromLatest.scope) {
    for (const m of messages.slice(0, -1)) {
      const earlier = scopeAndStage({
        stage,
        onFile: onFile.inquiryScope,
        rawInbound: m.body,
        mediaCount: m.mediaCount ?? 0,
      });
      if (earlier.scope) {
        // The stage never goes BACKWARDS: whichever floor is higher wins, so
        // recovering a scope cannot undo progress the intents already made.
        scope = { ...earlier, stage: Math.max(earlier.stage, fromLatest.stage) };
        break;
      }
    }
  }

  /**
   * A SCOPE WE STORED FROM THEIR OWN WORDS IS STILL THEIRS NEXT TURN —
   * found 2026-10-16 replaying Kate's corpus, on 43% of first texts.
   *
   * scheduler-db writes a customer-typed scope to inquiry_scope so the next
   * turn does not have to find it again. On that next turn it came back as
   * `onFile`, resolveScope called it "record", and scopeFromCustomer went
   * false for the rest of the conversation. Two rules turn on that flag and
   * both broke:
   *
   *   A3   "project details" counts as collected only via scopeFromCustomer,
   *        so `success` was refused as details_never_collected — and the one
   *        satisfier left was confirm_scope
   *   A9   which refuses confirm_scope only while scopeFromCustomer is true,
   *        so the bot was then free, and forced, to read their own sentence
   *        back at them
   *
   *   customer  "Hi, I need the outside of my house painted, 2 story colonial"
   *   ...address, email, "Monday morning works"
   *   BOT       success refused: details_never_collected
   *
   * The lead who describes the job in message one could never be booked.
   * The simulator and the scenario engine re-read the whole thread with no
   * row, so they kept calling it "customer" and stayed green.
   *
   * THE PROVENANCE IS IN THE THREAD, so no column is needed to keep it. What
   * we store is exactly scopeFromCustomer() of one of their messages; if the
   * value on file is that, they said it in this conversation, which is the
   * EVENT A3 asks for. A lead-form scope matches no message they typed, so it
   * stays "record" and still owes its confirm_scope — the distinction
   * scopeFromCustomer exists to keep. If a customer happens to type the lead
   * form's words verbatim, they have said it to us, and the same rule holds.
   *
   * This needs every customer message, not just the latest, which is why
   * live-turn.ts now passes the whole thread as `messages` says it should.
   *
   * The stage floor follows, for the same reason it does on the turn they
   * typed it: the step is done. Without it a conversation that deferred a
   * price question (no flow intent) sat at stage 0 once the scope was on the
   * row, and confirm_address was refused out_of_order.
   */
  if (scope.from === "record" && scope.scope) {
    const same = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const onFileScope = same(scope.scope);
    const theyTypedIt = messages.some((m) =>
      same(scopeFromCustomer(normalizeInbound(m.body, m.mediaCount ?? 0).text)) === onFileScope);
    if (theyTypedIt) scope = { ...scope, from: "customer", stage: Math.max(scope.stage, 1) };
  }

  // The address can have arrived at ANY point. The live path gets that for
  // free because the conversation row remembers; the sandbox has to look.
  // Their own words only: a reaction quotes our sentence back, and an address
  // in it would be ours.
  /**
   * ONE value, decided once, and used by BOTH the guard below and the return.
   * Splitting them is what caused the bug documented there: the guard tested
   * truthiness and the return used `??`, so "" behaved as absent in one and as
   * present in the other. Whitespace counts as absent too — a column somebody
   * cleared often holds " " rather than "" or NULL.
   */
  const onFileAddress = (onFile.address ?? "").trim() || null;

  const said = onFileAddress
    ? null
    : messages
        .map((m) => addressFromCustomer(normalizeInbound(m.body, m.mediaCount ?? 0).text ?? ""))
        .find(Boolean) ?? null;

  /**
   * TRUTHINESS HERE TOO, NOT `??` — AND THE MISMATCH KILLED THE TURN.
   *
   * Three lines up, `said` is scanned only when onFile.address is FALSY. This
   * returned `onFile.address ?? said`, and `??` falls through on null and
   * undefined but NOT on "". So an empty-string address scanned the thread,
   * found the address the customer had just typed, and then threw it away and
   * returned "" anyway.
   *
   * What that looked like, in the simulator on 2026-09-27:
   *
   *   customer  "I need my living room painted. I'm Tom Smith,
   *              tom@example.com, and the address is 12 Oak St, Garden City
   *              NY 11530"
   *   BOT       The reply was rejected before sending.
   *             confirm_address needs a known address and there is none on file
   *
   * A DEAD TURN — the customer gave everything in one message and got nothing
   * back. The model was right, the parser was right, and the value was
   * discarded between them.
   *
   * An empty string rather than NULL is an ordinary shape for a text column
   * somebody has edited and cleared, so this is not a sandbox-only concern:
   * any conversation whose customer_address is "" can never register an
   * address again, on any turn, for the life of the thread.
   */
  /**
   * THE EMAIL, WHICH NOTHING WAS KEEPING EITHER — the third of these, and the
   * one that costs the most.
   *
   * The bot asks for it by name ("Can I grab your name and email for the
   * quote?"), the customer answers, and customer_email was written once at
   * enrolment and never again. So the answer went nowhere, and on the
   * off-site route the quote is supposed to GO to it (A6, A7).
   *
   * Same shape as the two above: the record wins, whitespace counts as
   * absent, and the thread is only scanned when we hold nothing. What the
   * office has is never overwritten by something read out of a text message.
   */
  const onFileEmail = (onFile.email ?? "").trim().toLowerCase() || null;

  const saidEmail = onFileEmail
    ? null
    : messages
        .map((m) => emailFromCustomer(normalizeInbound(m.body, m.mediaCount ?? 0).text ?? ""))
        .find(Boolean) ?? null;

  return {
    inquiryScope: scope.scope,
    scopeFrom: scope.from,
    address: onFileAddress ?? said,
    addressFromChat: !onFileAddress && !!said,
    email: onFileEmail ?? saidEmail,
    emailFromChat: !onFileEmail && !!saidEmail,
    stage: scope.stage,
  };
}
