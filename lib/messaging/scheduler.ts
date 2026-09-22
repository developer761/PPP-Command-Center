/**
 * The worker behind the messaging tick (see app/api/cron/messaging-tick).
 *
 * Claims due rows, runs each through the gate, and decides what a refusal
 * MEANS. That last part is the whole job: a blanket "retry later" would chase
 * somebody who opted out forever, and a blanket "give up" would drop a message
 * that was merely sent at 8pm.
 *
 * Ports are injected so every branch is testable without a database, a clock or
 * a carrier.
 */
import type { E164 } from "./phone";
import type { GateResult, GateWorkspace, SendRequest, GateDeps } from "./gate";

/** After this many tries a row stops retrying and asks for a human. Five
 *  minute-ly attempts is enough to ride out a transient carrier blip; more
 *  than that is a broken thing being hammered, not a flaky one recovering. */
export const MAX_ATTEMPTS = 5;

export type DueAction = {
  id: string;
  conversation_id: string;
  campaign_step_id: string | null;
  action: string;
  attempts: number;
  /** agent_turn and send_reply: when the reply should reach the customer. */
  reply_due_at?: string | null;
  /** send_reply: the held reply and the message it answers. */
  reply_body?: string | null;
  reply_intent?: string | null;
  reply_confidence?: number | null;
  answers_message_id?: string | null;
};

export type ActionOutcome =
  | { kind: "sent"; providerId: string }
  | { kind: "drafted" }
  /** Written, and waiting for its moment as a send_reply. */
  | { kind: "held"; at: Date }
  | { kind: "rescheduled"; at: Date; reason: string }
  | { kind: "cancelled"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "skipped"; reason: string };

export type SchedulerDeps = {
  claimDue(limit: number): Promise<DueAction[]>;
  /** Everything needed to send, resolved per action. Null when the row points
   *  at something that no longer exists. */
  resolve(a: DueAction): Promise<{
    workspace: GateWorkspace;
    to: E164;
    body: string;
    agent: string;
    conversationState: string;
    /** Which channel this step is. An email step sent as an SMS blasts a
     *  subject line and newlines at a phone number. */
    channel?: "sms" | "email";
    toEmail?: string | null;
    fromEmail?: string | null;
    replyToEmail?: string | null;
    subject?: string | null;
  } | null>;
  send(req: SendRequest): Promise<GateResult>;
  markSent(a: DueAction, providerId: string, body: string, channel?: "sms" | "email", intent?: string | null): Promise<void>;
  /**
   * Close the row without recording a message. A turn that filed a draft or
   * held a reply sent nothing, and used to be closed with markSent(a,
   * "drafted", ""): an empty outbound message in the thread, which counted
   * toward the daily cap and told the gate we had already texted this person,
   * so Emily's real first reply went out without the opt-out line.
   */
  markDone(a: DueAction): Promise<void>;
  /**
   * Put the row back with a new time.
   *
   * `why` is not decoration. `attempts` increments when a row is CLAIMED, and
   * nothing reset it, so every deferral used to spend one of the five tries a
   * row gets. That made the kindest branches lethal: with the opt-out list not
   * yet imported the gate defers every send, so an opener would be refused
   * hourly and permanently failed about five hours later — the exact opposite
   * of the comment in classifyRefusal promising the queue "drains by itself the
   * moment somebody imports it". A person holding a conversation over lunch did
   * the same to every campaign step on it.
   *
   * "error" spends an attempt, because something is broken and retries must be
   * bounded. "deferral" gives it back, because nothing is wrong: the message is
   * simply not allowed yet.
   */
  reschedule(a: DueAction, at: Date, reason: string, why: "error" | "deferral"): Promise<void>;
  cancel(a: DueAction, reason: string): Promise<void>;
  fail(a: DueAction, reason: string): Promise<void>;
  /**
   * Run the agent for this conversation and park the reply for a person.
   *
   * A separate dep rather than a branch inside send, because drafting and
   * sending are different acts with different failure modes: a draft that
   * cannot be written is a bug, while a send that is refused is often the
   * system working. Optional so a caller that only drains campaign steps —
   * every existing test — does not have to supply one.
   */
  draftReply?(a: DueAction): Promise<
    | { kind: "drafted" }
    | { kind: "held"; at: Date }
    | { kind: "sent"; providerId: string; body: string; intent?: string | null }
    | { kind: "skipped"; reason: string }
  >;
  /**
   * Deliver a held reply at its moment: drop it if the customer has texted
   * since, send it through the gate otherwise, and file a draft if the gate
   * says no.
   */
  sendHeldReply?(a: DueAction): Promise<
    | { kind: "sent"; providerId: string; body: string }
    | { kind: "drafted" }
    | { kind: "skipped"; reason: string }
  >;
  now?: Date;
};

/**
 * A refusal is not one thing. Suppression is permanent, quiet hours is a clock,
 * and a workspace with no number is a configuration problem a human has to fix.
 * Treating them alike is how a system either spams or silently drops.
 */
export function classifyRefusal(r: Extract<GateResult, { ok: false }>): "cancel" | "reschedule" | "fail" {
  switch (r.reason) {
    case "suppressed":
      // They told us to stop. There is no later.
      return "cancel";
    case "quiet_hours":
    case "weekend":
    case "daily_cap":
      // Legal or permitted later; the gate already said when.
      return "reschedule";
    case "suppression_list_empty":
      // Not a broken message: a list nobody has loaded yet. Held rather than
      // failed, so the queue drains by itself the moment somebody imports it,
      // instead of a day of campaign steps having to be dug out by hand.
      return "reschedule";
    case "no_workspace_number":
    case "no_email_address":
    case "empty_body":
    case "unresolved_merge_field":
    case "no_sender_address":
    case "channel_not_supported":
    // The same body is the same length in an hour. Somebody has to look at why
    // the agent produced eighteen texts' worth of prose.
    case "too_long":
      // Retrying cannot fix any of these. Surface them instead of hiding them
      // in a queue — a placeholder nobody defined needs somebody to define it.
      return "fail";
  }
}

/** Process one claimed action. Exported so every branch is directly testable. */
export async function runAction(a: DueAction, deps: SchedulerDeps): Promise<ActionOutcome> {
  if (a.attempts > MAX_ATTEMPTS) {
    const reason = `gave up after ${a.attempts} attempts`;
    await deps.fail(a, reason);
    return { kind: "failed", reason };
  }

  const ctx = await deps.resolve(a);
  if (!ctx) {
    const reason = "conversation or step no longer exists";
    await deps.cancel(a, reason);
    return { kind: "cancelled", reason };
  }

  // THE RACE. The cancel-on-end trigger catches rows that are pending or
  // claimed, but a conversation can end in the instant between this worker
  // claiming its row and reaching the send. Without re-reading state here, the
  // customer who just booked gets the chase message anyway — the exact bug the
  // trigger exists to prevent, arriving through the one door it cannot cover.
  if (ctx.conversationState === "ended") {
    const reason = "conversation ended after this action was claimed";
    await deps.cancel(a, reason);
    return { kind: "cancelled", reason };
  }

  // A HELD REPLY. Written by a turn that ran seconds ago, due now.
  //
  // Handled before the human_active deferral below on purpose: a campaign step
  // held for an hour while somebody handles the customer is still the right
  // step afterwards, but Emily's answer to a message a person is now dealing
  // with is not. It is dropped, never sent late.
  if (a.action === "send_reply") {
    if (ctx.conversationState === "human_active") {
      const reason = "a person took the conversation over before the reply was due";
      await deps.cancel(a, reason);
      return { kind: "cancelled", reason };
    }
    if (!deps.sendHeldReply) {
      const reason = "this worker cannot send held replies";
      await deps.cancel(a, reason);
      return { kind: "cancelled", reason };
    }
    try {
      const out = await deps.sendHeldReply(a);
      if (out.kind === "sent") {
        await deps.markSent(a, out.providerId, out.body);
        return { kind: "sent", providerId: out.providerId };
      }
      if (out.kind === "drafted") {
        await deps.markDone(a);
        return { kind: "drafted" };
      }
      await deps.cancel(a, out.reason);
      return { kind: "cancelled", reason: out.reason };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (a.attempts >= MAX_ATTEMPTS) {
        await deps.fail(a, reason);
        return { kind: "failed", reason };
      }
      const at = new Date((deps.now ?? new Date()).getTime() + backoffMs(a.attempts));
      await deps.reschedule(a, at, reason, "error");
      return { kind: "rescheduled", at, reason };
    }
  }

  // A person has taken this conversation over. A scripted step arriving in the
  // middle of a human handling a complaint is worse than the step being late,
  // and this is the one path that reaches the carrier rather than a review
  // queue — so it waits.
  //
  // Deferred rather than cancelled: somebody holding it now does not make the
  // step wrong forever, and they may hand it straight back. An hour, the same
  // guess this function already makes when the gate cannot say when.
  if (ctx.conversationState === "human_active") {
    const reason = "a person has taken this conversation over";
    const at = new Date((deps.now ?? new Date()).getTime() + 3600_000);
    await deps.reschedule(a, at, reason, "deferral");
    return { kind: "rescheduled", at, reason };
  }

  // An agent turn produces a REPLY, not a campaign step. While autosend is off
  // that reply goes to a person rather than a carrier, so it never reaches the
  // gate on this path — the gate runs when the human presses send.
  if (a.action === "agent_turn") {
    if (!deps.draftReply) {
      const reason = "this worker cannot run agent turns";
      await deps.cancel(a, reason);
      return { kind: "cancelled", reason };
    }
    try {
      const out = await deps.draftReply(a);
      if (out.kind === "drafted") {
        await deps.markDone(a);
        return { kind: "drafted" };
      }
      if (out.kind === "held") {
        await deps.markDone(a);
        return { kind: "held", at: out.at };
      }
      // A workspace that has earned autosend replies on its own — but only
      // through the gate, and never when the agent asked for a person.
      if (out.kind === "sent") {
        await deps.markSent(a, out.providerId, out.body, "sms", out.intent);
        return { kind: "sent", providerId: out.providerId };
      }
      await deps.cancel(a, out.reason);
      return { kind: "cancelled", reason: out.reason };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (a.attempts >= MAX_ATTEMPTS) {
        await deps.fail(a, reason);
        return { kind: "failed", reason };
      }
      const at = new Date((deps.now ?? new Date()).getTime() + backoffMs(a.attempts));
      await deps.reschedule(a, at, reason, "error");
      return { kind: "rescheduled", at, reason };
    }
  }

  let result: GateResult;
  try {
    result = await deps.send({
      workspace: ctx.workspace, to: ctx.to, body: ctx.body,
      channel: ctx.channel ?? "sms", toEmail: ctx.toEmail ?? null,
      fromEmail: ctx.fromEmail ?? null, replyToEmail: ctx.replyToEmail ?? null,
      subject: ctx.subject ?? null,
      agent: ctx.agent, now: deps.now,
    });
  } catch (err) {
    // The carrier threw. Transient until proven otherwise — but attempts was
    // already incremented at claim time, so this cannot loop forever.
    const reason = err instanceof Error ? err.message : String(err);
    if (a.attempts >= MAX_ATTEMPTS) {
      await deps.fail(a, reason);
      return { kind: "failed", reason };
    }
    const at = new Date((deps.now ?? new Date()).getTime() + backoffMs(a.attempts));
    await deps.reschedule(a, at, reason, "error");
    return { kind: "rescheduled", at, reason };
  }

  if (result.ok) {
    // result.body, not ctx.body — the gate may have appended the opt-out
    // disclosure, and the thread must show what the customer actually got.
    await deps.markSent(a, result.providerId, result.body, ctx.channel ?? "sms");
    return { kind: "sent", providerId: result.providerId };
  }

  const disposition = classifyRefusal(result);
  if (disposition === "cancel") {
    await deps.cancel(a, result.reason);
    return { kind: "cancelled", reason: result.reason };
  }
  if (disposition === "fail") {
    await deps.fail(a, result.reason);
    return { kind: "failed", reason: result.reason };
  }
  // The gate told us when. If it somehow did not, an hour is a safer guess
  // than dropping the message.
  const at = result.retryAt ?? new Date((deps.now ?? new Date()).getTime() + 3600_000);
  await deps.reschedule(a, at, result.reason, "deferral");
  return { kind: "rescheduled", at, reason: result.reason };
}

/** Exponential-ish backoff, capped. 1, 2, 4, 8, 16 minutes. */
export function backoffMs(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts - 1), 16) * 60_000;
}

export type TickSummary = {
  /** Replies written and waiting for a person. */
  drafted: number;
  /** Replies written and waiting for their moment (30-90s after the text). */
  held: number;
  claimed: number;
  sent: number;
  rescheduled: number;
  cancelled: number;
  failed: number;
  skipped: number;
};

/** One tick. Returns counts so the caller can alert on them — a tick that
 *  processed nothing and a tick that failed everything must not look alike. */
export async function runDueActions(deps: SchedulerDeps, limit = 50): Promise<TickSummary> {
  const claimed = await deps.claimDue(limit);
  const s: TickSummary = { claimed: claimed.length, sent: 0, drafted: 0, held: 0, rescheduled: 0, cancelled: 0, failed: 0, skipped: 0 };
  for (const a of claimed) {
    // One bad row must not stop the tick — the rest of the queue is unrelated.
    try {
      const out = await runAction(a, deps);
      if (out.kind === "sent") s.sent++;
      else if (out.kind === "drafted") s.drafted++;
      else if (out.kind === "held") s.held++;
      else if (out.kind === "rescheduled") s.rescheduled++;
      else if (out.kind === "cancelled") s.cancelled++;
      else if (out.kind === "failed") s.failed++;
      else s.skipped++;
    } catch {
      s.failed++;
    }
  }
  return s;
}
