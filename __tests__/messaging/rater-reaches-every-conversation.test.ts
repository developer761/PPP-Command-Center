import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sweepUnrated, RATINGS_PER_TICK } from "@/lib/messaging/rater-db";

/**
 * CONVERSATIONS THE RATER COULD NEVER REACH.
 *
 * sweepUnrated's own first line says "rate every conversation that has
 * finished and has not been rated". It took the newest `RATINGS_PER_TICK * 4`
 * ended conversations and skipped the ones already rated.
 *
 * But that window is of ALL ended conversations, so the already-rated ones
 * occupy it. Once the newest twenty are rated, every older unrated
 * conversation is permanently unreachable — not slow to reach, unreachable,
 * because every tick looks at the same twenty and finds them done.
 *
 * At 171 leads a day the window is passed within a day of going live, so the
 * conversations that would never be rated are the ones from the first days of
 * the rollout: the ones worth learning from most. Production has 4 ended and
 * 4 rated, which is the only reason it has not shown yet.
 */
type Conv = { id: string; workspace_id: string | null; outcome: string | null; ended_at: string };

/**
 * A stub that honours range() over an ordered list, so paging is really
 * exercised rather than assumed. `ratedIds` are the conversations that already
 * carry a source='live' training example.
 */
function stub(convs: Conv[], ratedIds: Set<string>) {
  /**
   * The shape loadTurnsForRating actually reads — `direction` and `body`, not
   * role and text. The first version of this stub used the mapped shape, so
   * every turn came back with an empty body, was filtered out, and the
   * conversation was skipped as "no bot turn to rate" — which looked exactly
   * like the sweep failing to reach it.
   */
  const turnsFor = () => [
    { direction: "inbound", body: "hi", created_at: "2026-01-01T10:00:00Z", id: "m1" },
    { direction: "outbound", body: "Hello! What are you looking to have painted?", created_at: "2026-01-01T10:00:30Z", id: "m2" },
  ];
  const client = {
    from: (table: string) => {
      const state: { from: number; to: number; ids: string[] | null } = { from: 0, to: 999, ids: null };
      const chain: Record<string, unknown> = {};
      for (const m of ["eq", "is", "not", "neq", "order", "limit", "gte", "lte"]) chain[m] = () => chain;
      chain.select = () => chain;
      chain.range = (f: number, t: number) => { state.from = f; state.to = t; return chain; };
      chain.in = (_col: string, vals: string[]) => { state.ids = vals; return chain; };
      chain.then = (res: (v: unknown) => unknown) => {
        if (table === "sms_conversations") {
          return Promise.resolve({ data: convs.slice(state.from, state.to + 1), error: null }).then(res);
        }
        if (table === "sms_training_examples") {
          const hit = (state.ids ?? []).filter((i) => ratedIds.has(i)).map((i) => ({ source_ref: i }));
          return Promise.resolve({ data: hit, error: null }).then(res);
        }
        if (table === "sms_messages") {
          return Promise.resolve({ data: turnsFor(), error: null }).then(res);
        }
        return Promise.resolve({ data: [], error: null }).then(res);
      };
      return {
        select: (...a: unknown[]) => (chain.select as (...x: unknown[]) => unknown)(...a),
        insert: () => chain, update: () => chain,
      };
    },
  } as unknown as SupabaseClient;
  return client;
}

const conv = (n: number): Conv => ({
  id: `c${String(n).padStart(4, "0")}`, workspace_id: "ws-1", outcome: "booked",
  ended_at: new Date(Date.UTC(2026, 0, 1) + n * 3600_000).toISOString(),
});

/** The rater is never actually called: these assert WHICH rows get picked. */
const askNothing = async () => ({ findings: [] });

describe("the rater can reach a conversation older than one window", () => {
  it("reaches an old unrated conversation behind a wall of rated ones", async () => {
    // 200 ended conversations. The OLDEST is unrated; everything after it is
    // rated. The old window was the newest 20, so this one was invisible.
    const convs = Array.from({ length: 200 }, (_, i) => conv(i));
    const rated = new Set(convs.slice(1).map((c) => c.id));
    const out = await sweepUnrated(stub(convs, rated), { ask: askNothing as never, loadRules: (async () => []) as never });
    // It does not matter here whether the rating itself succeeded — only that
    // the sweep got as far as considering the one conversation that needed it.
    expect(out.rated + out.failed, "the old unrated conversation was never reached").toBeGreaterThan(0);
    expect(out.skipped["already rated"], "it did not page past the rated ones").toBeGreaterThan(20);
  });

  it("does nothing when every ended conversation is already rated", async () => {
    const convs = Array.from({ length: 60 }, (_, i) => conv(i));
    const out = await sweepUnrated(stub(convs, new Set(convs.map((c) => c.id))), { ask: askNothing as never, loadRules: (async () => []) as never });
    expect(out.rated).toBe(0);
    expect(out.failed).toBe(0);
  });

  it("stops at its page bound and says so rather than running for ever", async () => {
    // 5,000 ended conversations, all rated: twenty pages of fifty is the bound.
    const convs = Array.from({ length: 5000 }, (_, i) => conv(i));
    const out = await sweepUnrated(stub(convs, new Set(convs.map((c) => c.id))), { ask: askNothing as never, loadRules: (async () => []) as never });
    const stopped = Object.keys(out.skipped).find((k) => /stopped after \d+ pages/.test(k));
    expect(stopped, `no page-bound note in ${JSON.stringify(out.skipped)}`).toBeTruthy();
  });

  it("takes no more than RATINGS_PER_TICK in one pass", async () => {
    const convs = Array.from({ length: 200 }, (_, i) => conv(i));
    const out = await sweepUnrated(stub(convs, new Set()), { ask: askNothing as never, loadRules: (async () => []) as never });
    expect(out.rated + out.failed).toBeLessThanOrEqual(RATINGS_PER_TICK);
  });
});

/**
 * AND A FAILED READ IS NOT AN EMPTY ONE.
 *
 * Both reads discarded their errors. An empty result is indistinguishable from
 * "nothing has finished", so a timeout reported scanned 0, rated 0, failed 0 —
 * which reads exactly like a healthy quiet tick. Worse for the second read:
 * an unreadable list of what is already rated read as "none of these are
 * rated", which would rate them all again and teach from a duplicate.
 */
describe("the rater does not mistake a failed read for an empty one", () => {
  function failing(table: string) {
    const client = {
      from: (t: string) => {
        const chain: Record<string, unknown> = {};
        for (const m of ["eq", "is", "not", "neq", "order", "limit", "range", "in"]) chain[m] = () => chain;
        chain.select = () => chain;
        chain.then = (res: (v: unknown) => unknown) => Promise.resolve(
          t === table
            ? { data: null, error: { message: "statement timeout" } }
            : { data: [], error: null }
        ).then(res);
        return {
          select: (...a: unknown[]) => (chain.select as (...x: unknown[]) => unknown)(...a),
          insert: () => chain, update: () => chain,
        };
      },
    } as unknown as SupabaseClient;
    return client;
  }

  it("throws when the ended-conversation list cannot be read", async () => {
    await expect(sweepUnrated(failing("sms_conversations"), { ask: askNothing as never, loadRules: (async () => []) as never }))
      .rejects.toThrow(/list ended conversations/);
  });

  it("throws when it cannot tell which conversations are already rated", async () => {
    const convs = Array.from({ length: 3 }, (_, i) => conv(i));
    const client = stub(convs, new Set());
    // Re-wrap so only the training-examples read fails.
    const broken = {
      from: (t: string) => t === "sms_training_examples"
        ? (failing("sms_training_examples") as unknown as { from: (x: string) => unknown }).from(t)
        : (client as unknown as { from: (x: string) => unknown }).from(t),
    } as unknown as SupabaseClient;
    await expect(sweepUnrated(broken, { ask: askNothing as never, loadRules: (async () => []) as never }))
      .rejects.toThrow(/already rated/);
  });
});
