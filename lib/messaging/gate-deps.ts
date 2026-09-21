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

/**
 * An email address is a VALUE here, not a pattern.
 *
 * `ilike` is used for case-insensitivity, but ILIKE also reads `_` as "any one
 * character" and `%` as "any run of characters" — and `_` is common in real
 * addresses. Unescaped, a lookup for john_doe@example.com also matched
 * johnxdoe@example.com. Over-matching was not the danger; matching TWO rows
 * was, because the query then errored and the error read as "not suppressed".
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * A database that will not answer is not permission to send.
 *
 * postgrest-js does not throw — it returns `{ data: null, error }` — so a
 * lookup that destructures only `data` reads a timeout, a 5xx or a dropped
 * connection as an empty result. For the suppression check an empty result
 * means "they never opted out", which is how a blip becomes a message to
 * somebody who said STOP.
 *
 * These throw instead. The scheduler already treats a throw as transient and
 * retries with backoff, so the message is DEFERRED rather than sent or lost —
 * which is the only safe direction for a rail.
 */
function refuseToGuess(what: string, e: { message?: string; code?: string }): never {
  throw new Error(`${what}: ${e.message ?? "database error"}${e.code ? ` (code ${e.code})` : ""}`);
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
        .from("sms_opt_outs").select("id", { count: "exact", head: true })
        // ACTIVE suppressions only. Rows are never deleted — START sets
        // opted_in_at — so a list of 200 rows where every one has opted back
        // in is an empty suppression list, and counting them said the rail
        // was satisfied by a list that suppresses nobody.
        .is("opted_in_at", null);
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
        // limit(1), NOT maybeSingle(). maybeSingle errors with PGRST116 when
        // more than one row matches, and `!!data` on that error answered "not
        // suppressed" — so a second similar address on the list was enough to
        // email somebody who had unsubscribed. One match or ten, the answer is
        // the same.
        const { data, error } = await sb
          .from("sms_opt_outs").select("id")
          .ilike("email", escapeLike(target.email)).is("opted_in_at", null).limit(1);
        if (error) refuseToGuess("could not check the suppression list", error);
        return (data ?? []).length > 0;
      }
      if (!target.phone) return true;
      const { data, error } = await sb
        .from("sms_opt_outs").select("id")
        .eq("phone_e164", target.phone).is("opted_in_at", null).limit(1);
      if (error) refuseToGuess("could not check the suppression list", error);
      return (data ?? []).length > 0;
    },

    async hasEverSent(to: E164) {
      // Across every workspace. Somebody who has heard from PPP before has
      // already been told how to stop, and repeating the disclosure on first
      // contact from each of fifteen workspaces would read as spam.
      //
      // FAILS THE OTHER WAY ON PURPOSE. Being wrong here sends one more
      // "Reply STOP to opt out" to somebody who has already seen it, which is
      // harmless; refusing the send instead would block a message over a
      // cosmetic question. So an error answers "no" and the disclosure goes on
      // again — the opposite direction from the rails above, deliberately.
      const { data, error } = await sb.from("sms_conversations").select("id").eq("customer_phone", to);
      if (error) return false;
      const ids = (data ?? []).map((c) => c.id);
      if (!ids.length) return false;
      const { count, error: countErr } = await sb
        .from("sms_messages").select("id", { count: "exact", head: true })
        .in("conversation_id", ids).eq("direction", "outbound");
      if (countErr) return false;
      return (count ?? 0) > 0;
    },

    async sentToday(to: E164) {
      // Across every agent and workspace — the cap belongs to the handset, not
      // to whoever happens to be texting it.
      const since = new Date(Date.now() - 24 * 3600_000).toISOString();
      const { data, error } = await sb.from("sms_conversations").select("id").eq("customer_phone", to);
      // Answering 0 on a failed read says "they have had nothing today", which
      // is how a capped customer gets a fourth message.
      if (error) refuseToGuess("could not count today's messages, so the daily cap cannot be enforced", error);
      const ids = (data ?? []).map((c) => c.id);
      if (!ids.length) return 0;
      const { count, error: countErr } = await sb
        .from("sms_messages").select("id", { count: "exact", head: true })
        .in("conversation_id", ids).eq("direction", "outbound").gte("created_at", since);
      if (countErr) refuseToGuess("could not count today's messages, so the daily cap cannot be enforced", countErr);
      return count ?? 0;
    },
  };
}
