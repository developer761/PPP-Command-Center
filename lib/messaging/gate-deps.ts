/**
 * The real suppression and daily-cap lookups the gate needs.
 *
 * Extracted rather than copied. This session has already produced two bugs
 * from two implementations of one idea drifting apart — a dashboard that
 * disagreed with itself about what a success was, and an opt-out write that
 * could not work against the real index. The scheduler and the draft-review
 * screen both send, so they both need these, and a second copy is how the
 * email half of a suppression quietly stops being checked on one path.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GateDeps, SendChannel } from "./gate";
import type { E164 } from "./phone";

export function gateDeps(sb: SupabaseClient): GateDeps {
  return {
    async isSuppressed(target: { phone: E164 | null; email: string | null }, channel: SendChannel) {
      // The identifier for the channel we are about to use. 92 of the 213
      // failed Hatch opt-outs came in over email, and a sequence that sends
      // both would otherwise keep emailing somebody who unsubscribed.
      if (channel === "email") {
        if (!target.email) return true; // no address = nothing we may send to
        const { data } = await sb
          .from("sms_opt_outs").select("id")
          .ilike("email", target.email).is("opted_in_at", null).maybeSingle();
        return !!data;
      }
      if (!target.phone) return true;
      const { data } = await sb
        .from("sms_opt_outs").select("id")
        .eq("phone_e164", target.phone).is("opted_in_at", null).maybeSingle();
      return !!data;
    },

    async sentToday(to: E164) {
      // Across every agent and workspace — the cap belongs to the handset, not
      // to whoever happens to be texting it.
      const since = new Date(Date.now() - 24 * 3600_000).toISOString();
      const { data } = await sb.from("sms_conversations").select("id").eq("customer_phone", to);
      const ids = (data ?? []).map((c) => c.id);
      if (!ids.length) return 0;
      const { count } = await sb
        .from("sms_messages").select("id", { count: "exact", head: true })
        .in("conversation_id", ids).eq("direction", "outbound").gte("created_at", since);
      return count ?? 0;
    },
  };
}
