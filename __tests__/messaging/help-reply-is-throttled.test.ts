import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordInbound, type Accepted } from "@/lib/messaging/record-inbound";
import { HELP_INTENT } from "@/lib/messaging/compliance";
import type { E164 } from "@/lib/messaging/phone";

/**
 * TWENTY HELPS GOT TWENTY REPLIES.
 *
 * The CTIA HELP reply was exempted from the daily cap earlier the same day —
 * correctly, because a cap written to ration marketing must not swallow a
 * reply the law requires. What that removed was the only thing bounding how
 * many could go out.
 *
 * `isNew` does not bound it: it dedupes a carrier REDELIVERY of one text, by
 * provider id, not a person sending HELP twenty times. Nor does the schema —
 * the step-once index keys on campaign_step_id, which is NULL for a HELP
 * reply. So twenty texts queued twenty exempt replies from one 10DLC number
 * inside ten minutes, which is the pattern a carrier spam filter flags, during
 * the A2P vetting this reply exists to pass, and PPP pays per message.
 *
 * The after-hours reply eight lines below already had the brake — it counts
 * its own intent over 24 hours and passes `alreadySentToday`. The HELP block
 * was the only required-reply path without it. This is that same brake.
 *
 * CTIA requires answering a HELP request. It does not require answering the
 * twentieth one in ten minutes.
 */

type Call = { table: string; op: string; payload?: Record<string, unknown>; filters: string[] };

/**
 * `sent` / `queued` are what the two new counts come back with. Everything
 * else returns empty, which is enough to carry the webhook as far as the HELP
 * block — the writes are what this asserts, and they all happen before
 * anything that could throw.
 */
function stubClient(opts: { sent: number; queued: number }) {
  const calls: Call[] = [];
  const chainFor = (call: Call, result: unknown) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "not", "neq", "order", "limit", "ilike", "in", "gte", "lte"]) {
      chain[m] = (...args: unknown[]) => {
        call.filters.push(`${m}(${args.map(String).join(",")})`);
        return chain;
      };
    }
    chain.maybeSingle = async () => result;
    chain.single = async () => result;
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
    return chain;
  };
  const client = {
    from: (table: string) => {
      const start = (op: string, payload?: Record<string, unknown>) => {
        const call: Call = { table, op, payload, filters: [] };
        calls.push(call);
        let result: unknown = { data: null, error: null, count: 0 };
        if (table === "sms_sub_accounts" && op === "select") {
          result = { data: { id: "ws-1", phone_e164: "+15163448418", after_hours_autoreply: false }, error: null };
        }
        if (table === "sms_conversations" && op === "select") {
          result = { data: { id: "conv-1", state: "ai_active" }, error: null };
        }
        if (table === "sms_messages" && op === "select") {
          // Two different reads hit this table: the count of HELP replies
          // already sent, and the lookup of the inbound being answered. The
          // count is the one with a head/count option, so it is told apart by
          // the filter the production code puts on it.
          result = { data: { id: "msg-1" }, error: null, count: opts.sent };
        }
        if (table === "sms_scheduled_actions" && op === "select") {
          result = { data: [], error: null, count: opts.queued };
        }
        return chainFor(call, result);
      };
      return {
        insert: (p: Record<string, unknown>) => start("insert", p),
        update: (p: Record<string, unknown>) => start("update", p),
        select: (...a: unknown[]) => {
          const c = start("select");
          return (c as Record<string, (...x: unknown[]) => unknown>).select(...a);
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const help = (providerId: string): Accepted => ({
  kind: "accept",
  from: "+15165550147" as E164,
  to: "+15163448418" as E164,
  body: "HELP",
  providerId,
  mediaCount: 0,
  keyword: "help",
});

async function ingest(opts: { sent: number; queued: number }) {
  const s = stubClient(opts);
  await recordInbound(s.client, help("p-1")).catch(() => {});
  return s.calls.filter(
    (c) => c.table === "sms_scheduled_actions" && c.op === "insert"
      && c.payload?.reply_intent === HELP_INTENT
  );
}

describe("the required HELP reply answers once a day, not once a text", () => {
  it("answers the first HELP", async () => {
    const queued = await ingest({ sent: 0, queued: 0 });
    expect(queued).toHaveLength(1);
    // Still immediate, and still a reply the gate will treat as required.
    expect(queued[0].payload?.reply_intent).toBe(HELP_INTENT);
  });

  it("does not answer again when one has already gone out today", async () => {
    expect(await ingest({ sent: 1, queued: 0 })).toHaveLength(0);
  });

  /**
   * THE BURST CASE, which the sent-count alone cannot see.
   *
   * Five texts in five seconds all find zero replies SENT, because none has
   * been sent yet — the queue is a minute of cron away. Without this second
   * count all five queue, and the gate then sends all five.
   */
  it("does not answer again when one is already queued and unsent", async () => {
    expect(await ingest({ sent: 0, queued: 1 })).toHaveLength(0);
  });

  it("counts only this conversation's own HELP replies", async () => {
    const s = stubClient({ sent: 0, queued: 0 });
    await recordInbound(s.client, help("p-1")).catch(() => {});
    const counts = s.calls.filter(
      (c) => c.op === "select" && c.filters.some((f) => f.includes(HELP_INTENT))
    );
    expect(counts.length, "neither count ran").toBeGreaterThanOrEqual(2);
    for (const c of counts) {
      expect(
        c.filters.some((f) => f.startsWith("eq(conversation_id")),
        `a HELP count was not scoped to one conversation: ${c.table} ${c.filters.join(" ")}`
      ).toBe(true);
    }
  });

  /**
   * The window is a day, not for ever. Somebody who asks for help next week is
   * owed an answer — that is the whole obligation — so the count is bounded by
   * a gte on created_at, exactly as the after-hours twin bounds its own.
   */
  it("bounds the sent count to the last 24 hours", async () => {
    const s = stubClient({ sent: 0, queued: 0 });
    await recordInbound(s.client, help("p-1")).catch(() => {});
    const sentCount = s.calls.find(
      (c) => c.table === "sms_messages" && c.filters.some((f) => f.includes(`agent_intent,${HELP_INTENT}`))
    );
    expect(sentCount, "no count of HELP replies already sent").toBeTruthy();
    expect(sentCount!.filters.some((f) => f.startsWith("gte(created_at"))).toBe(true);
  });
});
