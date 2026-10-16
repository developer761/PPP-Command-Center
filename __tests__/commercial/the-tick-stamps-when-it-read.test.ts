/**
 * The two things the write-back tick has to hand the queue, asserted at the
 * seam rather than read off the source.
 *
 * Both are invisible from either side on its own. `tomco-queue.ts` can only
 * say what it does with the arguments it is given; `tomco-tick.ts` can only
 * say that it passes them. The defects live in the gap, and both of them are
 * silent — nothing throws, nothing logs, and the queue row looks perfect
 * afterwards.
 *
 *  1. WHAT TIME IT STAMPS. The tick reads the deal, then marks the entry done
 *     ten to twenty seconds later — Salesforce round trips plus a six-second
 *     wait for the rollups. `needsRequeue` re-queues a thing only when
 *     `updated_at > done_at`, so an edit landing inside that gap is written
 *     with an `updated_at` BELOW the completion time and is never swept
 *     again. Not by the tick, which is finished; not by the nightly sweep,
 *     which thinks nothing has changed. Salesforce keeps the pre-edit figure
 *     for ever and both systems report success.
 *  2. WHAT IT REFUNDS. The attempt is now spent by `claimPending` as it takes
 *     the entry, so that an entry which KILLS the tick still costs one. That
 *     makes "a hold does not spend an attempt" something the tick has to ask
 *     for: a hold sets `last_attempt_at`, the entry is re-claimable an hour
 *     later, and a deal waiting on Katie would run out of retries in three
 *     hours and be abandoned — the exact outcome the hold exists to prevent.
 *
 * Mocked at the module boundary, which is the only way to watch a seam: the
 * real `runWriteBackTick` runs, and the calls it makes are recorded. The
 * stamping maths and the sweep decision are then run through the REAL
 * `completionStamp` and `needsRequeue`, so this test asserts the behaviour
 * the nightly sweep will actually get.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type MarkDoneCall = { id: string; outcome: string; opts: { verified?: boolean; readAt?: string | null } };
type MarkHeldCall = { id: string; reason: string; opts: { attemptsBeforeClaim?: number } };

const h = vi.hoisted(() => {
  const state = {
    markDone: [] as MarkDoneCall[],
    markHeld: [] as MarkHeldCall[],
    markFailed: [] as Array<{ id: string; attempts: number }>,
    markDoneAt: 0,
    /** When the mocked `loadSoldDeal` was actually called. */
    loadedAt: 0,
    toClaim: [] as Array<Record<string, unknown>>,
    /** What `decideWriteBack` should answer. */
    plan: { action: "update", sfId: "0065g00000AAAAAAAA", why: "already linked" } as Record<string, unknown>,
    /** What `syncChangeOrder` should answer. */
    coResult: { action: "nothing", why: "nothing to do", label: "CO-1", checks: [], steps: [] } as Record<
      string,
      unknown
    >,
    /** How long the write takes — the window this test is about. */
    writeMs: 40,
  };
  return state;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

vi.mock("@/lib/salesforce/client", () => ({
  isSalesforceConfigured: () => true,
  getSalesforceClient: async () => ({ query: async () => ({ records: [] }) }),
}));

vi.mock("@supabase/supabase-js", () => {
  // `pairedSfIdFor` only: .from().select().eq().eq().maybeSingle()
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.eq = () => builder;
  builder.maybeSingle = async () => ({ data: null });
  return { createClient: () => ({ from: () => builder }) };
});

vi.mock("@/lib/salesforce/tomco-queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/salesforce/tomco-queue")>();
  return {
    ...actual,
    claimPending: async () => {
      // A real claim is a round trip; without the delay `readAt` and the read
      // can land in the same millisecond and the ordering assertion is vacuous.
      await sleep(5);
      const next = h.toClaim.shift();
      return next ? [next] : [];
    },
    peekPending: async () => [],
    markDone: async (id: string, outcome: string, opts = {}) => {
      h.markDoneAt = Date.now();
      h.markDone.push({ id, outcome, opts });
    },
    markHeld: async (id: string, reason: string, opts = {}) => {
      h.markHeld.push({ id, reason, opts });
    },
    markFailed: async (id: string, attempts: number) => {
      h.markFailed.push({ id, attempts });
    },
    markVerifyFailed: async () => {},
  };
});

vi.mock("@/lib/salesforce/tomco-pairing", () => ({
  isSoldStatus: () => true,
  listOpenSalesforceCandidates: async () => [],
  listResolvedDeals: async () => new Map(),
  loadSoldDeal: async (id: string) => {
    h.loadedAt = Date.now();
    return {
      deal: { id, title: "Probe · 100 Main St", accountName: null, contractCents: 1000, decidedAt: null },
      createdAt: "2026-10-01T00:00:00.000Z",
      sold: true,
    };
  },
}));

vi.mock("@/lib/salesforce/tomco-decide", () => ({ decideWriteBack: () => h.plan }));

vi.mock("@/lib/salesforce/tomco-writeback", () => ({
  CREATED_LINK_NOTE: "created by the Tomco write-back",
  createNew: async () => {
    await sleep(h.writeMs);
    return { action: "created", checks: [{ name: "contract value", ok: true, detail: "" }], steps: ["created"] };
  },
  updateExisting: async () => {
    // The six-second rollup wait, in miniature. THIS is the window.
    await sleep(h.writeMs);
    return { action: "updated", checks: [{ name: "contract value", ok: true, detail: "" }], steps: ["updated"] };
  },
}));

vi.mock("@/lib/salesforce/tomco-changeorder", () => ({
  CO_MAP_ENTITY: "change_order",
  ROLLUP_TITLE: /^rollup/i,
  syncChangeOrder: async () => h.coResult,
}));

const { runWriteBackTick, needsRequeue } = await import("@/lib/salesforce/tomco-tick");
const { completionStamp } = await import("@/lib/salesforce/tomco-queue");

const entry = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-1111-1111-111111111111",
  kind: "sale" as const,
  opportunityId: "22222222-2222-2222-2222-222222222222",
  changeOrderId: null,
  attempts: 0,
  queuedAt: "2026-10-16T00:00:00.000Z",
  ...over,
});

beforeEach(() => {
  h.markDone.length = 0;
  h.markHeld.length = 0;
  h.markFailed.length = 0;
  h.markDoneAt = 0;
  h.loadedAt = 0;
  h.toClaim.length = 0;
  h.plan = { action: "update", sfId: "0065g00000AAAAAAAA", why: "already linked" };
  h.coResult = { action: "nothing", why: "nothing to do", label: "CO-1", checks: [], steps: [] };
  h.writeMs = 40;
});

describe("the instant a finished entry is stamped with", () => {
  it("is when the tick looked at the deal, not when it stopped writing", async () => {
    h.toClaim.push(entry());
    const out = await runWriteBackTick({ apply: true, limit: 1 });

    expect(out.claimed).toBe(1);
    expect(h.markDone).toHaveLength(1);
    const readAt = h.markDone[0].opts.readAt;
    expect(readAt, "the tick passed no read timestamp at all").toBeTruthy();
    const stamped = Date.parse(completionStamp(readAt));

    // Taken before the deal was read — so nothing the entry acted on predates it.
    expect(stamped).toBeLessThanOrEqual(h.loadedAt);
    // And meaningfully before the entry finished. That difference IS the bug:
    // in production it is ten to twenty seconds, here it is the mocked write.
    expect(h.markDoneAt - stamped).toBeGreaterThanOrEqual(h.writeMs);
  });

  it("so an edit made while the entry was being written is swept, not lost", async () => {
    h.toClaim.push(entry());
    await runWriteBackTick({ apply: true, limit: 1 });

    // Somebody corrects the contract one millisecond after the tick read the
    // deal — inside the write, so the figure that reached Salesforce is stale.
    const editedAt = new Date(h.loadedAt + 1).toISOString();
    expect(h.markDoneAt).toBeGreaterThan(h.loadedAt + 1);

    const stamped = completionStamp(h.markDone[0].opts.readAt);
    expect(
      needsRequeue({ doneAt: stamped }, editedAt),
      "the nightly sweep must pick this edit up — nothing else ever will",
    ).toBe(true);

    // And the shape of the defect, kept where it can be read: stamping the
    // COMPLETION — which is what the code did — hides exactly this edit.
    const stampedAtCompletion = new Date(h.markDoneAt).toISOString();
    expect(needsRequeue({ doneAt: stampedAtCompletion }, editedAt)).toBe(false);
  });

  it("never stamps a completion in the future, whatever it is handed", async () => {
    // A caller passing a clock-skewed or garbage timestamp must not park the
    // row ahead of every future edit, which would lose the sweep entirely.
    const now = new Date("2026-10-16T12:00:00.000Z");
    expect(completionStamp("2027-01-01T00:00:00.000Z", now)).toBe(now.toISOString());
    expect(completionStamp("not a date", now)).toBe(now.toISOString());
    expect(completionStamp(null, now)).toBe(now.toISOString());
    expect(completionStamp("2026-10-16T11:59:30.000Z", now)).toBe("2026-10-16T11:59:30.000Z");
  });
});

describe("what a hold hands back", () => {
  it("refunds the attempt the claim spent", async () => {
    h.plan = { action: "hold", why: "two Salesforce opportunities could be this deal" };
    h.toClaim.push(entry({ attempts: 2 }));

    await runWriteBackTick({ apply: true, limit: 1 });

    expect(h.markHeld).toHaveLength(1);
    expect(
      h.markHeld[0].opts.attemptsBeforeClaim,
      "without the refund a deal waiting on a person stalls in three hours",
    ).toBe(2);
    expect(h.markFailed).toHaveLength(0);
  });

  it("refunds on the hold the change-order path takes too", async () => {
    h.coResult = { action: "held", why: "the sale has not reached Salesforce yet", label: "CO-1", checks: [], steps: [] };
    h.toClaim.push(entry({ kind: "change_order", changeOrderId: "33333333-3333-3333-3333-333333333333" }));

    await runWriteBackTick({ apply: true, limit: 1 });

    expect(h.markHeld).toHaveLength(1);
    expect(h.markHeld[0].opts.attemptsBeforeClaim).toBe(0);
  });
});
