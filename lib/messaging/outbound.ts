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
  if (error?.code === UNKNOWN_COLUMN) {
    await sb.from("sms_messages").insert(base);
  }
}
