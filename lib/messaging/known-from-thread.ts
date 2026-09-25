import { scopeAndStage } from "./scope";
import { addressFromCustomer } from "./address";
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

  // Scope and the stage floor come from the newest message, because that is
  // the one the stage is being decided for.
  const scope = scopeAndStage({
    stage,
    onFile: onFile.inquiryScope,
    rawInbound: latest?.body ?? "",
    mediaCount: latest?.mediaCount ?? 0,
  });

  // The address can have arrived at ANY point. The live path gets that for
  // free because the conversation row remembers; the sandbox has to look.
  // Their own words only: a reaction quotes our sentence back, and an address
  // in it would be ours.
  const said = onFile.address
    ? null
    : messages
        .map((m) => addressFromCustomer(normalizeInbound(m.body, m.mediaCount ?? 0).text ?? ""))
        .find(Boolean) ?? null;

  return {
    inquiryScope: scope.scope,
    scopeFrom: scope.from,
    address: onFile.address ?? said,
    addressFromChat: !onFile.address && !!said,
    stage: scope.stage,
  };
}
