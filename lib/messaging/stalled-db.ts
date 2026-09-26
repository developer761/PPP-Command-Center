/**
 * A44 and A45, against the database.
 *
 * The rules themselves are pure and live in stalled.ts and call-signals.ts.
 * This is the half that reads and writes, kept separate for the usual reason:
 * the cadence arithmetic is the part worth testing, and it should be testable
 * without a database.
 *
 * ── WHAT THE SWEEP DOES ─────────────────────────────────────────────────
 *
 * Finds conversations where the last turn was ours and no human ever picked
 * it up, and queues three follow-ups at the instants followUpSchedule()
 * computes. Idempotent by construction: the unique index on
 * (conversation_id, stall_step) means a sweep that runs twice cannot chase
 * anybody twice, so this does not need to be careful about being run again.
 *
 * ── AND WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────
 *
 * It never ends a conversation. A44: "run the follow-up cadence and then hand
 * the conversation on — NEVER END IT." The ending recorded at the far end is
 * `stalled`, which is a Hub record, not a disposition, and Salesforce is
 * untouched by every path in this file.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isStalled, followUpSchedule, FOLLOW_UP_COUNT } from "./stalled";
import { pauseOnReply, resumeAfterCadence, type CallSignal } from "./call-signals";
import { customerZone } from "./customer-clock";
import { selectAll } from "./paging";

/** How long a conversation must be quiet before it counts as stalled. */
export const QUIET_HOURS_BEFORE_STALL = 24;

type ConversationRow = {
  id: string;
  workspace_id: string;
  customer_phone: string;
  sf_lead_id: string | null;
  state: string;
  outcome: string | null;
  last_message_at: string | null;
  takeover_at: string | null;
  unreachable_start_hour: number | null;
  unreachable_end_hour: number | null;
  customer_zip: string | null;
};

/**
 * Queue the three follow-ups for every conversation that has gone quiet.
 *
 * Returns what it did, per conversation, so the caller can report rather than
 * guess. `now` is an argument so the sweep is testable at a chosen instant.
 */
export async function sweepStalled(
  sb: SupabaseClient,
  opts: { now?: Date; officeZoneFor?: (workspaceId: string) => string } = {}
): Promise<{ scanned: number; queued: number; skipped: Record<string, number> }> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - QUIET_HOURS_BEFORE_STALL * 3600_000).toISOString();

  // Paged and ordered by a unique column: an unbounded select stops at 1,000
  // rows and a range without a stable sort returns an arbitrary window.
  const convs = await selectAll<ConversationRow>(
    (from, to) => sb.from("sms_conversations")
      .select("id, workspace_id, customer_phone, sf_lead_id, state, outcome, last_message_at, takeover_at, unreachable_start_hour, unreachable_end_hour, customer_zip")
      .neq("state", "ended")
      .lt("last_message_at", cutoff)
      .order("id")
      .range(from, to),
    "sms_conversations (stall sweep)"
  );

  const skipped: Record<string, number> = {};
  const note = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  let queued = 0;

  for (const c of convs) {
    // The last turn has to be OURS. Read from the messages table rather than
    // inferred from state, because state can be moved by a person.
    const { data: last } = await sb.from("sms_messages")
      .select("direction, agent_intent")
      .eq("conversation_id", c.id)
      .order("created_at", { ascending: false })
      .limit(1);
    const lastMsg = last?.[0];
    if (!lastMsg) { note("no messages"); continue; }

    if (!isStalled({
      lastTurnWasBot: lastMsg.direction === "outbound",
      everHadHuman: Boolean(c.takeover_at) || c.state === "human_active",
      lastIntent: lastMsg.agent_intent,
      suppressed: false,   // the gate refuses a suppressed send anyway
    })) { note("not stalled"); continue; }

    // Already has a cadence? The unique index would refuse anyway; asking
    // first keeps the log honest about what was skipped and why.
    const { count: existing } = await sb.from("sms_scheduled_actions")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", c.id)
      .eq("action", "stall_followup")
      .neq("state", "cancelled");
    if ((existing ?? 0) > 0) { note("cadence already queued"); continue; }

    const zone = customerZone({ phone: c.customer_phone }).timeZone;
    const at = followUpSchedule({
      from: new Date(c.last_message_at ?? now.toISOString()),
      // A conversation that has been quiet for weeks still gets its cadence
      // from TODAY. Without this the three instants are all historical, land
      // immediately due, and go out together on the next tick.
      notBefore: now,
      customerZone: zone,
      officeZone: opts.officeZoneFor?.(c.workspace_id),
      unreachable: c.unreachable_start_hour === null ? null : {
        startHour: c.unreachable_start_hour,
        endHour: c.unreachable_end_hour ?? c.unreachable_start_hour,
      },
    });
    if (!at.length) { note("no sendable slot"); continue; }

    const { error } = await sb.from("sms_scheduled_actions").insert(
      at.map((run_at, i) => ({
        conversation_id: c.id,
        action: "stall_followup",
        stall_step: i + 1,
        run_at: run_at.toISOString(),
      }))
    );
    // 23505 is the unique index refusing a second cadence, which is the
    // outcome we wanted. Anything else is reported rather than swallowed.
    if (error && error.code !== "23505") { note(`insert failed ${error.code}`); continue; }
    if (error) { note("cadence already queued"); continue; }
    queued++;
  }

  return { scanned: convs.length, queued, skipped };
}

/**
 * Record a signal for the call centre, or do nothing if one already went.
 *
 * The unique index is what actually guarantees "one pause per conversation";
 * this returns false on 23505 rather than treating it as a failure, because a
 * duplicate is the constraint working.
 */
export async function recordSignal(sb: SupabaseClient, signal: CallSignal): Promise<boolean> {
  const { error } = await sb.from("sms_call_signals").insert({
    conversation_id: signal.conversationId,
    kind: signal.kind,
    sf_lead_id: signal.leadId,
    note: signal.note,
  });
  if (!error) return true;
  if (error.code === "23505") return false;   // already sent — the point of the index
  throw new Error(`could not record ${signal.kind}: ${error.code} ${error.message}`);
}

/**
 * A45's pause, on a customer reply.
 *
 * Called from the inbound path. `alreadyPaused` is answered by the insert
 * itself rather than by a read, so two concurrent webhooks cannot both decide
 * there is no pause yet.
 */
export async function pauseCallingFor(
  sb: SupabaseClient,
  input: { conversationId: string; leadId: string | null }
): Promise<boolean> {
  const signal = pauseOnReply({
    conversationId: input.conversationId,
    leadId: input.leadId,
    alreadyPaused: false,           // the unique index is the real guard
    customerReplied: true,
  });
  return signal ? recordSignal(sb, signal) : false;
}

/**
 * A45's resume, off the end of A44's cadence.
 *
 * Fires only where all three follow-ups are done AND the customer never
 * replied to any of them. Spec: "The resume signal fires only at the end of
 * A44's cadence, and only where the customer was never reached."
 */
export async function resumeCallingIfSpent(
  sb: SupabaseClient,
  input: { conversationId: string; leadId: string | null }
): Promise<boolean> {
  const { count: done } = await sb.from("sms_scheduled_actions")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", input.conversationId)
    .eq("action", "stall_followup")
    .eq("state", "done");

  // Did they answer any of them? An inbound after the cadence started is a
  // reply, and a reply means we reached them.
  const { data: firstStep } = await sb.from("sms_scheduled_actions")
    .select("run_at")
    .eq("conversation_id", input.conversationId)
    .eq("action", "stall_followup")
    .order("run_at").limit(1);
  let everReplied = false;
  if (firstStep?.[0]) {
    const { count: replies } = await sb.from("sms_messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", input.conversationId)
      .eq("direction", "inbound")
      .gte("created_at", firstStep[0].run_at);
    everReplied = (replies ?? 0) > 0;
  }

  const signal = resumeAfterCadence({
    conversationId: input.conversationId,
    leadId: input.leadId,
    cadenceSpent: (done ?? 0) >= FOLLOW_UP_COUNT,
    everReplied,
    alreadyResumed: false,          // again, the unique index is the guard
  });
  if (!signal) return false;

  const recorded = await recordSignal(sb, signal);
  if (recorded) {
    /**
     * The ending is recorded in OUR record only. Spec: "the Hub records the
     * ending as Stalled conversation, and Salesforce is untouched."
     *
     * The conversation is NOT closed — A44 says never end it. Only the
     * outcome is stamped, so the board can show what happened while the
     * thread stays open for a person or a later reply.
     */
    await sb.from("sms_conversations")
      .update({ outcome: "stalled" })
      .eq("id", input.conversationId)
      .is("outcome", null);
  }
  return recorded;
}
