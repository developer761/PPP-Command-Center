/**
 * Writing down a message that actually left the building.
 *
 * ONE PLACE, because there are now four paths to a customer — a campaign step,
 * the agent, a held reply, and a person typing — and each of them has to record
 * the same row. The last time this logic existed in two places (recordInbound
 * and a hand-written copy in verify-inbound-e2e) they drifted, and the drift
 * hid a bug that returned 500s for hours.
 *
 * TOLERATES THE MIGRATION NOT BEING APPLIED. agent_intent arrives with
 * 20260922114500, and this repo applies migrations by hand, so there is always
 * a window where the code is deployed and the column is not. A failed insert
 * here does not mean "no message" — the carrier has ALREADY accepted it. Losing
 * the row would leave a customer holding a text the system has no record of,
 * which breaks the thread, the daily cap and the opt-out disclosure all at
 * once. So an unknown-column error retries without it rather than giving up.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { reportWarn } from "@/lib/observability";

/** Postgres: column does not exist. */
const UNKNOWN_COLUMN = "42703";

export type OutboundRow = {
  conversation_id: string;
  body: string;
  provider_id: string;
  channel?: "sms" | "email";
  /** The intent the agent chose. Null for campaign steps and for a person's
   *  own words, both of which are correct. */
  agent_intent?: string | null;
  /** Who pressed send, when a person did. */
  sent_by_user_id?: string | null;
  /** Their name, for the thread and the per-agent report. */
  sent_by_agent?: string | null;
};

export async function recordOutbound(sb: SupabaseClient, row: OutboundRow): Promise<void> {
  const base = {
    conversation_id: row.conversation_id,
    direction: "outbound" as const,
    // Recorded on the channel it actually went out on. Every email step used to
    // be filed as an SMS, so a thread showed an email as a text.
    channel: row.channel ?? "sms",
    body: row.body,
    provider_id: row.provider_id,
    delivery_status: "sent",
    ...(row.sent_by_user_id ? { sent_by_user_id: row.sent_by_user_id } : {}),
    ...(row.sent_by_agent ? { sent_by_agent: row.sent_by_agent } : {}),
  };

  const { error } = await sb.from("sms_messages").insert({
    ...base,
    ...(row.agent_intent ? { agent_intent: row.agent_intent } : {}),
  });
  /**
   * THE RETRY'S OWN ERROR WAS NEVER READ, AND NEITHER WAS ANY OTHER.
   *
   * This checked for 42703 and discarded everything else, and the second
   * insert's result was not looked at at all. Every failure other than a
   * missing column — a constraint, a dropped connection, RLS — ended here in
   * silence, and the caller went on to return ok: true.
   *
   * The header above says what that costs, and it is not small: "a customer
   * holding a text the system has no record of, which breaks the thread, the
   * daily cap and the opt-out disclosure all at once". The cap counts ROWS and
   * the disclosure fires on the first outbound ROW, so a missing one can mean
   * the next message repeats the disclosure or exceeds the cap, with the
   * thread showing neither.
   *
   * IT STILL MUST NOT THROW. The carrier has already accepted the message —
   * the header is emphatic that a failed insert does not mean "no message" —
   * and throwing would hand a retry to a caller whose retry is another TEXT.
   * Loud, not fatal: the warning carries the conversation and provider id,
   * which is everything needed to write the row by hand.
   */
  const failed = error?.code === UNKNOWN_COLUMN
    ? (await sb.from("sms_messages").insert(base)).error
    : error;

  if (failed) {
    reportWarn({
      key: "outbound_not_recorded",
      message: "a message was sent and could not be written to the thread",
      platform: "ppp_cc",
      context: {
        conversationId: row.conversation_id,
        providerId: row.provider_id,
        channel: row.channel ?? "sms",
        error: failed.message,
        code: failed.code ?? null,
      },
    });
  }
}
