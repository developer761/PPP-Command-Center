import { knownFromThread, type KnownFromThread } from "./known-from-thread";

/**
 * WHAT A LIVE TURN IS FED, lifted out of scheduler-db.draftReply so a test
 * can run the same derivation production does without a database.
 *
 * Pure. The caller has already read the conversation row and its messages,
 * and does the writes itself.
 */

/** The conversation columns the derivation reads. */
export type LiveRow = {
  inquiry_scope?: string | null;
  customer_address?: string | null;
  customer_email?: string | null;
};

/** One sms_messages row, oldest first. */
export type LiveMessage = {
  direction: string;
  body: string;
  media_count?: number | null;
};

export type LiveTurnInputs = {
  /** The transcript handed to runAgentTurn as "the conversation so far". */
  history: { role: "customer" | "assistant"; text: string }[];
  /**
   * What runAgentTurn is told the customer has just sent. EMPTY when nothing
   * has arrived since our last message — see speaksAfterUs.
   */
  inboundBody: string;
  /** Photos on that message. */
  mediaCount: number;
  /** What we hold, from the row and from their own words. */
  resolved: KnownFromThread;
};

export function liveTurnInputs(input: {
  row: LiveRow;
  msgs: readonly LiveMessage[];
  /** stageFromIntents over the bot's own past intents. */
  stage0: number;
  /** A stall follow-up or a park re-open: the one turn that may speak after us. */
  speaksAfterUs?: boolean;
}): LiveTurnInputs | null {
  const { row, msgs, stage0 } = input;
  const history = msgs.map((m) => ({
    role: (m.direction === "inbound" ? "customer" : "assistant") as "customer" | "assistant",
    text: m.body,
  }));
  const inbound = msgs.filter((m) => m.direction === "inbound");
  const lastInbound = inbound[inbound.length - 1];
  if (!lastInbound) return null;

  /**
   * A FOLLOW-UP AFTER SILENCE WAS FED THE CUSTOMER'S OLD MESSAGE AS NEW —
   * found 2026-10-16.
   *
   * This was `history.slice(0, -1)` and `lastInbound.body` for every turn,
   * which assumes the newest message is the inbound being answered. That is
   * true of an ordinary turn — latestInboundIsAnswered skips it otherwise —
   * and FALSE BY DEFINITION of a stall follow-up or a park re-open, where the
   * newest message is ours. So the slice dropped our own last question from
   * the transcript, and the customer's message from days ago was presented as
   * "The customer has just sent".
   *
   *   customer  "do you guys do ceilings too?"
   *   BOT       "Yes, we do ceilings too. ..."
   *   ...three days of silence, follow-up 1
   *   ask_address refused question_left_unanswered — a question we answered
   *
   * and where the old message was not a question, ask_address rendered the
   * zip floor, "No problem. We at least need the zip code to price it
   * accurately.", conceding to a refusal nobody made, into silence (A28).
   *
   * So when the newest message is ours, the whole thread is the history and
   * nothing is the inbound. Only then: if they texted after the follow-up was
   * queued, their message is new and it is what this turn answers.
   */
  const nothingNew = !!input.speaksAfterUs && msgs[msgs.length - 1]?.direction !== "inbound";

  /**
   * EVERY customer message, which is what knownFromThread's `messages` has
   * always said it takes. Production passed the latest alone, on the
   * reasoning that the row remembers what earlier turns found. The row
   * remembers the VALUE and not where it came from, and the provenance check
   * in knownFromThread needs the thread to tell a scope they typed from one
   * off the lead form. It also makes this the same input the simulator gives.
   */
  const resolved = knownFromThread({
    onFile: {
      inquiryScope: row.inquiry_scope,
      address: row.customer_address,
      email: row.customer_email,
    },
    messages: inbound.map((m) => ({ body: m.body, mediaCount: m.media_count ?? 0 })),
    stage: stage0,
  });

  return nothingNew
    ? { history, inboundBody: "", mediaCount: 0, resolved }
    : {
        history: history.slice(0, -1),
        inboundBody: lastInbound.body,
        mediaCount: lastInbound.media_count ?? 0,
        resolved,
      };
}

/**
 * The row as it stands after draftReply's three guarded writes.
 *
 * draftReply does the writes itself, as `.update(...).is(column, null)`, so
 * the first value wins and the office's never gets overwritten. This is the
 * same rule without a database, for the harnesses that replay a thread turn
 * by turn: the scenario engine re-read scope from the whole thread with no
 * row at all, so it never saw what the next live turn reads back, and that
 * hid the stored-scope bug documented in known-from-thread.ts.
 */
export function persistedRow<R extends LiveRow>(row: R, resolved: KnownFromThread): R {
  const empty = (v: string | null | undefined) => v === null || v === undefined;
  return {
    ...row,
    ...(resolved.scopeFrom === "customer" && resolved.inquiryScope && empty(row.inquiry_scope)
      ? { inquiry_scope: resolved.inquiryScope } : {}),
    ...(resolved.addressFromChat && resolved.address && empty(row.customer_address)
      ? { customer_address: resolved.address } : {}),
    ...(resolved.emailFromChat && resolved.email && empty(row.customer_email)
      ? { customer_email: resolved.email } : {}),
  };
}
