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
import { FOLLOW_UP_COUNT } from "./stalled";
import { HELP_INTENT } from "./compliance";
import { CarrierUnsubscribedError } from "./transports/twilio";

/** After this many tries a row stops retrying and asks for a human. Five
 *  minute-ly attempts is enough to ride out a transient carrier blip; more
 *  than that is a broken thing being hammered, not a flaky one recovering. */
export const MAX_ATTEMPTS = 5;

/**
 * How long a person may hold a conversation before its queued steps are given
 * up on rather than deferred again. See the human_active branch below.
 *
 * Two weeks, because that is already this system's unit for "come back to this
 * later" — A40's event park waits exactly that long. A step still waiting
 * after it has outlived the longest pause the rules describe.
 */
export const HUMAN_HOLD_HORIZON_MS = 14 * 24 * 3600_000;

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
  /** A44: which of the three stall follow-ups this is (1, 2 or 3). */
  stall_step?: number | null;
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
    /** When a person took it over, for bounding the deferral below. Null reads
     *  as "no horizon" and keeps deferring, so a missing value can never cause
     *  a cancellation. */
    takeoverAt?: string | null;
    /** Which channel this step is. An email step sent as an SMS blasts a
     *  subject line and newlines at a phone number. */
    channel?: "sms" | "email";
    toEmail?: string | null;
    fromEmail?: string | null;
    replyToEmail?: string | null;
    subject?: string | null;
  } | { cancelBecause: string } | null>;
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
    /**
     * `retryable` means the reason is TRUE NOW AND NOT FOREVER — a draft
     * waiting on a reviewer, a person holding the thread. Without it every
     * skip was cancelled, and the cadence died on states that clear by
     * themselves. See the stall_followup branch below.
     *
     * `blockedSince` is when the thing being waited ON started, so "not for
     * ever" can be CHECKED rather than taken on trust. Two of the three
     * retryable reasons do clear by themselves. The draft one does not:
     * nothing ages a pending draft out — `superseded` exists as a state and
     * nothing in lib/ or app/ writes it — and a "deferral" reschedule refunds
     * the attempt, so the step never reaches MAX_ATTEMPTS either. It defers
     * hourly for ever.
     */
    | { kind: "skipped"; reason: string; retryable?: boolean; blockedSince?: string | null }
  >;
  /**
   * Deliver a held reply at its moment: drop it if the customer has texted
   * since, send it through the gate otherwise, and file a draft if the gate
   * says no.
   */
  /**
   * A45: the cadence is spent. Fires ONLY off the third follow-up, and only
   * from the branch that actually sent it — a cadence that was cancelled or
   * refused never reached the customer, so handing the lead back would be
   * claiming three attempts that did not happen.
   *
   * Optional, so every existing test and any worker that only drains campaign
   * steps keeps working without supplying one.
   */
  onCadenceSpent?(a: DueAction): Promise<void>;
  /**
   * The carrier refused because THEY have this person suppressed and we did
   * not. Closes the gap by writing our own row, so the next workspace to try
   * is stopped by our gate rather than by a failed send. Optional, so a worker
   * that only drains campaign steps need not supply one.
   */
  onCarrierSuppressed?(a: DueAction, to: E164): Promise<void>;
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
    // A holiday is the weekend's twin: PPP's own policy, true today and not
    // tomorrow, and the gate has already worked out which day to come back on.
    case "holiday":
    case "daily_cap":
    // A36's office window. PPP is not working right now and will be later —
    // the same kind of answer as a weekend, not a broken message.
    case "office_closed":
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
  // Resolved fine, but the row should no longer send — an outreach step for
  // somebody who has since replied, say. Carries its own reason rather than
  // borrowing "no longer exists", because a cancelled row nobody can explain
  // is how a sequence gets turned back on by the next person to look at it.
  if ("cancelBecause" in ctx) {
    await deps.cancel(a, ctx.cancelBecause);
    return { kind: "cancelled", reason: ctx.cancelBecause };
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
    /**
     * THE CTIA REPLY IS NOT AN OPINION ABOUT THE CONVERSATION.
     *
     * Everything below this line decides whether Emily's ANSWER is still the
     * right thing to say — a person has taken over, or the customer has moved
     * on. Both are good reasons to drop a reply and bad reasons to drop HELP:
     * that one is a fixed, required string about how to stop and where to get
     * help, and it is just as true after somebody claims the thread.
     *
     * Carriers test HELP during A2P vetting, and these two cancels are silent.
     */
    const required = a.reply_intent === HELP_INTENT;
    if (!required && ctx.conversationState === "human_active") {
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
    /**
     * AND THE DEFERRAL NEEDS A HORIZON, or it is a loop wearing a reason.
     *
     * Found in production 2026-10-06, not by a test: FOUR pending actions,
     * every one of them deferring on this exact line, created 2026-09-26 and
     * still going ten days and roughly 240 reschedules later. That was 100% of
     * the pending queue. Nothing was wrong with any single deferral; there was
     * simply nothing that ever ended one.
     *
     * The reasoning above holds for an hour or a day — they may hand it
     * straight back. It does not hold for a fortnight. By then a scripted step
     * is not late, it is wrong: a stall follow-up chasing somebody a person
     * has been handling for two weeks reads as the left hand not knowing what
     * the right is doing, which is the failure handing over exists to prevent.
     *
     * At launch scale this is the shape that matters. Every conversation a
     * person ever touches would leave its remaining steps cycling hourly for
     * ever, each one costing a claim, a read and a write, and none of them
     * ever completing.
     *
     * Cancelled rather than failed: nothing broke. A person has it, which is
     * a legitimate ending for a step that was only ever a guess about silence.
     */
    const takenAt = ctx.takeoverAt ? Date.parse(ctx.takeoverAt) : NaN;
    const heldFor = Number.isNaN(takenAt) ? 0 : (deps.now ?? new Date()).getTime() - takenAt;
    if (heldFor > HUMAN_HOLD_HORIZON_MS) {
      const reason = "a person has held this conversation for over two weeks, "
        + "so the scripted step is no longer the right thing to send";
      await deps.cancel(a, reason);
      return { kind: "cancelled", reason };
    }
    const reason = "a person has taken this conversation over";
    const at = new Date((deps.now ?? new Date()).getTime() + 3600_000);
    await deps.reschedule(a, at, reason, "deferral");
    return { kind: "rescheduled", at, reason };
  }

  /**
   * A44 — A STALL FOLLOW-UP IS AN AGENT TURN, NOT A TEMPLATE.
   *
   * Karan chose this on 2026-09-26, and it is the reason conversation memory
   * is capability one in the build order: "parking and stalling both come
   * back to a conversation later and have to remember it." A follow-up that
   * has forgotten what was being discussed is the Hatch behaviour being
   * replaced — the first of the three structural failures on the spec's own
   * front page.
   *
   * So it runs the same constrained turn every reply runs: an intent plus a
   * template, never free text. The only difference is what triggered it.
   *
   * It goes through `draftReply` exactly like agent_turn, which means the
   * gate still decides whether it may go out, and A36's hours still bind —
   * the run_at was computed inside them, but a workspace whose hours changed
   * since should still be refused rather than sent late.
   */
  /**
   * A40 — THE BOT COMING BACK, at the time the customer named.
   *
   * Runs the same constrained turn a stall follow-up runs, and for the same
   * reason: it must resume "in the same thread and with full context", which
   * is what conversation memory is for. The only difference is what put the
   * row in the queue — a date the customer gave us, rather than silence.
   *
   * Shares the stall branch because the behaviour is identical: draft or send
   * through the gate, so A36's hours still bind at the moment it fires. What
   * it does NOT share is the cadence ending — a park has no third step and no
   * resume signal, so onCadenceSpent is never reached from here.
   */
  if (a.action === "stall_followup" || a.action === "park_reopen") {
    if (!deps.draftReply) {
      const reason = `this worker cannot run ${a.action}`;
      await deps.cancel(a, reason);
      return { kind: "cancelled", reason };
    }
    try {
      const out = await deps.draftReply(a);
      if (out.kind === "sent") {
        await deps.markSent(a, out.providerId, out.body, "sms", out.intent);
        // The LAST one hands the lead back to the phone team. A45's resume
        // fires off the end of the cadence, and only from the end.
        // Only A44's LAST follow-up hands the lead back. A park re-open is
        // not a cadence and never triggers a resume.
        if (a.action === "stall_followup" && a.stall_step === FOLLOW_UP_COUNT) {
          await deps.onCadenceSpent?.(a);
        }
        return { kind: "sent", providerId: out.providerId };
      }
      if (out.kind === "drafted") { await deps.markDone(a); return { kind: "drafted" }; }
      if (out.kind === "held") { await deps.markDone(a); return { kind: "held", at: out.at }; }

      /**
       * A REASON THAT CLEARS BY ITSELF IS NOT A REASON TO GIVE UP.
       *
       * Every skip used to be cancelled here, and several of draftReply's
       * skips describe a passing state: a draft waiting on a reviewer, a
       * person holding the thread, a turn handed to a person. Confirmed in
       * production 2026-10-06 — of the three A44 cadences that have ever run,
       * NONE can complete:
       *
       *   conversation 022606b8…  step 1 done
       *                           step 2 cancelled "a reply is already
       *                           step 3 cancelled  waiting for review"
       *
       * And the damage outlives the cadence. It cannot be re-queued, because
       * stalled-db counts non-cancelled rows and step 1 is done; and
       * resumeCallingIfSpent needs three DONE steps before it tells the call
       * centre it may dial again. So the lead is neither chased nor called —
       * the exact dead end A44 and A45 exist to close, produced by the
       * machinery built to close it.
       *
       * An hour, the same guess this file makes everywhere it defers, and the
       * human_active horizon above still ends anything a person keeps.
       */
      if (out.retryable) {
        /**
         * AND "NOT FOR EVER" HAS TO BE CHECKED, OR IT IS FOR EVER.
         *
         * The comment above says the human_active horizon still ends anything
         * a person keeps. It does not end THIS: that horizon is measured from
         * ctx.takeoverAt, and a draft nobody ever opened has no takeover. So a
         * stall_followup behind an abandoned draft deferred hourly with no
         * bound at all — nothing ages a pending draft out, and a "deferral"
         * reschedule refunds the attempt so MAX_ATTEMPTS is never reached
         * either. The same four production rows this branch was written to
         * rescue, in a different state.
         *
         * FAILED, NOT CANCELLED, and that distinction is the whole point.
         * Cancelling is what produced the dead end above: stalled-db will not
         * re-queue a cadence whose steps are cancelled, and a cancelled step
         * does not count towards a spent one either, so the lead was neither
         * chased nor called. A failed step DOES count (see
         * resumeCallingIfSpent), so once the cadence is spent the lead goes
         * back to the call centre — which is the right answer for a
         * conversation the bot cannot advance and nobody is reviewing.
         *
         * The same fourteen days as the human hold, deliberately rather than a
         * second number: the reasoning is identical — somebody has had this
         * long enough that the scripted step is no longer the right thing to
         * send — and a second horizon is one more thing to drift.
         */
        const since = out.blockedSince ? Date.parse(out.blockedSince) : NaN;
        const stuck = Number.isNaN(since) ? 0 : (deps.now ?? new Date()).getTime() - since;
        if (stuck > HUMAN_HOLD_HORIZON_MS) {
          const reason = `${out.reason}, and has been for over two weeks — `
            + "handing the lead back rather than deferring it again";
          await deps.fail(a, reason);
          return { kind: "failed", reason };
        }
        const at = new Date((deps.now ?? new Date()).getTime() + 3600_000);
        await deps.reschedule(a, at, out.reason, "deferral");
        return { kind: "rescheduled", at, reason: out.reason };
      }

      await deps.cancel(a, out.reason);
      return { kind: "cancelled", reason: out.reason };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await deps.fail(a, reason);
      return { kind: "failed", reason };
    }
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
    /**
     * A CARRIER-LEVEL OPT-OUT IS NOT TRANSIENT, and treating it as one is both
     * useless and wrong.
     *
     * Twilio keeps its own suppression list and enforces it before we do. Code
     * 21610 means this person is on it and NOT in sms_opt_outs — the two lists
     * have drifted. twilio.ts already said so in a comment ("not a transient
     * error, and retrying it will fail forever") and then threw a plain Error,
     * which this catch read as transient: five retries, then failed, and the
     * number never written down. Every other workspace went on trying them.
     *
     * So it cancels, and writes our own row first. The customer has told
     * SOMEBODY to stop, which is the only fact that matters.
     */
    if (err instanceof CarrierUnsubscribedError) {
      try {
        await deps.onCarrierSuppressed?.(a, err.to as E164);
      } catch {
        // Recording it is best effort; not recording it must not turn a
        // definite "do not text this person" back into a retry.
      }
      await deps.cancel(a, err.message);
      return { kind: "cancelled", reason: err.message };
    }

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
/**
 * How long a tick may spend working before it stops starting new rows.
 *
 * The route's maxDuration is 300s. A claimed row the lambda never reaches is
 * not free: `sms_claim_due_actions` increments `attempts` on the CLAIM, and
 * `sms_reclaim_stale_actions` returns the row to pending WITHOUT giving the
 * attempt back. So six abandoned ticks fail a message that was never once
 * attempted — "gave up after 6 attempts" about a send nobody tried.
 *
 * The obvious fix is to reset attempts on reclaim, and it is WRONG. The
 * migration says why: "Attempts increments on CLAIM, not completion, so a row
 * that crashes mid-send cannot retry forever." A row abandoned because the
 * tick ran out of time and a row abandoned because it crashed after the
 * carrier accepted look identical from the reclaim's side, and refunding both
 * would let the second retry for ever — a duplicate text, which is worse than
 * a late one.
 *
 * So the cause is fixed instead of the symptom: stop starting work there is no
 * time to finish. A row not claimed stays pending with its attempts intact and
 * is picked up by the next tick a minute later.
 *
 * 240s of 300 leaves room for the slowest single action to finish — an agent
 * turn is a model call and a handful of reads — plus the heartbeat write after
 * the loop.
 */
export const TICK_BUDGET_MS = 240_000;

export async function runDueActions(
  deps: SchedulerDeps,
  limit = 50,
  /** Overridable so the budget can be tested in milliseconds rather than by
   *  waiting four minutes. Production uses the default. */
  budgetMs = TICK_BUDGET_MS,
): Promise<TickSummary> {
  /**
   * REAL elapsed time, never deps.now. That clock is injected for business
   * decisions — "is it a weekend where this customer is" — and tests pin it to
   * a fixed instant. Measuring a wall-clock budget against a frozen clock made
   * every tick instantly over budget, which is how the first version of this
   * skipped every row in the suite.
   */
  const startedAt = Date.now();
  const claimed = await deps.claimDue(limit);
  const s: TickSummary = { claimed: claimed.length, sent: 0, drafted: 0, held: 0, rescheduled: 0, cancelled: 0, failed: 0, skipped: 0 };
  for (const a of claimed) {
    /**
     * OUT OF TIME: leave the rest claimed and let the reclaim return them.
     *
     * They each cost one attempt this way, which is the price of not knowing
     * whether an abandoned row had already reached the carrier. Stopping here
     * means only the rows we could not reach pay it, instead of every row in
     * an oversized batch paying it every tick.
     */
    if (Date.now() - startedAt > budgetMs) {
      s.skipped += claimed.length - (s.sent + s.drafted + s.held + s.rescheduled + s.cancelled + s.failed + s.skipped);
      break;
    }
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
