/**
 * The worker behind the minute-ly tick.
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
};

export type ActionOutcome =
  | { kind: "sent"; providerId: string }
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
  } | null>;
  send(req: SendRequest): Promise<GateResult>;
  markSent(a: DueAction, providerId: string, body: string): Promise<void>;
  reschedule(a: DueAction, at: Date, reason: string): Promise<void>;
  cancel(a: DueAction, reason: string): Promise<void>;
  fail(a: DueAction, reason: string): Promise<void>;
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
    case "no_workspace_number":
    case "empty_body":
      // Retrying cannot fix either. Surface it instead of hiding it in a queue.
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

  let result: GateResult;
  try {
    result = await deps.send({
      workspace: ctx.workspace, to: ctx.to, body: ctx.body,
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
    await deps.reschedule(a, at, reason);
    return { kind: "rescheduled", at, reason };
  }

  if (result.ok) {
    await deps.markSent(a, result.providerId, ctx.body);
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
  await deps.reschedule(a, at, result.reason);
  return { kind: "rescheduled", at, reason: result.reason };
}

/** Exponential-ish backoff, capped. 1, 2, 4, 8, 16 minutes. */
export function backoffMs(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts - 1), 16) * 60_000;
}

export type TickSummary = {
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
  const s: TickSummary = { claimed: claimed.length, sent: 0, rescheduled: 0, cancelled: 0, failed: 0, skipped: 0 };
  for (const a of claimed) {
    // One bad row must not stop the tick — the rest of the queue is unrelated.
    try {
      const out = await runAction(a, deps);
      if (out.kind === "sent") s.sent++;
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
