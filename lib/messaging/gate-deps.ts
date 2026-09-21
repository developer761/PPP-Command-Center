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

/**
 * Whether there is a suppression list at all, cached briefly.
 *
 * Counted once a minute rather than on every send: it changes when somebody
 * imports a list or a customer texts STOP, and counting per message would be a
 * database round trip for an answer that is the same all day.
 */
let listState: { loaded: boolean; at: number } | null = null;
const LIST_TTL_MS = 60_000;

/** For tests, and for the moment right after an import. */
export function clearSuppressionListCache(): void {
  listState = null;
}

export function gateDeps(sb: SupabaseClient): GateDeps {
  return {
    /**
     * THE PORT RAIL. Kate's Hatch export is not in yet, so sms_opt_outs is
     * empty, and an empty list answers "not suppressed" for everybody —
     * including the people who told Hatch to stop. While numbers are being
     * ported, live sending and an active workflow are two toggles apart, so
     * this refuses every send until the list exists.
     */
    async suppressionListLoaded() {
      // Stated in the environment: the list really is empty and that is not an
      // accident. An env var rather than a screen, because turning this off
      // should be a decision somebody makes on purpose.
      if (process.env.SUPPRESSION_LIST_CONFIRMED_EMPTY === "true") return true;

      const now = Date.now();
      if (listState && now - listState.at < LIST_TTL_MS) return listState.loaded;
      const { count, error } = await sb
        .from("sms_opt_outs").select("id", { count: "exact", head: true });
      // A failed count is not permission to text everybody: treated as not
      // loaded, the same as an empty list.
      const loaded = !error && (count ?? 0) > 0;
      listState = { loaded, at: now };
      return loaded;
    },

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

    async hasEverSent(to: E164) {
      // Across every workspace. Somebody who has heard from PPP before has
      // already been told how to stop, and repeating the disclosure on first
      // contact from each of fifteen workspaces would read as spam.
      const { data } = await sb.from("sms_conversations").select("id").eq("customer_phone", to);
      const ids = (data ?? []).map((c) => c.id);
      if (!ids.length) return false;
      const { count } = await sb
        .from("sms_messages").select("id", { count: "exact", head: true })
        .in("conversation_id", ids).eq("direction", "outbound");
      return (count ?? 0) > 0;
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
