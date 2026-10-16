/**
 * The tick's three decisions that must never become a Salesforce write:
 *
 *   F23 b — a FAILED read of the deal's link is not "never linked". It used to
 *           send an already-sold deal down the INSERT path.
 *   F24   — a deal DELETED here that Salesforce still holds is held for a
 *           person, never marked done and never written.
 *   F38   — a hold that waits for a person is PARKED (no hourly retry for
 *           ever); one that waits for an event keeps its clock, until a day
 *           has passed.
 *
 * Driven through the real `runWriteBackTick`, with the database and
 * Salesforce replaced by recorders — the same harness as
 * the-tick-stamps-when-it-read.test.ts. What is asserted is which writer was
 * called, never the source text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  markDone: [] as Array<{ id: string; outcome: string }>,
  markHeld: [] as Array<{ id: string; reason: string; opts: { waitsFor?: string } }>,
  markFailed: [] as Array<{ id: string; error: string }>,
  writes: [] as string[],
  /** What the import-map link read returns. */
  link: { data: null, error: null } as { data: unknown; error: { message: string } | null },
  /** What loadSoldDeal returns; null = deleted or gone. */
  loaded: null as null | Record<string, unknown>,
  plan: { action: "insert", why: "new" } as Record<string, unknown>,
  coResult: { action: "held", why: "the deal is not in Salesforce yet", label: "CO-1", checks: [], steps: [], waitsFor: "event" } as Record<string, unknown>,
  toClaim: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/salesforce/client", () => ({
  isSalesforceConfigured: () => true,
  getSalesforceClient: async () => ({ query: async () => ({ records: [] }) }),
}));

vi.mock("@supabase/supabase-js", () => {
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.eq = () => builder;
  builder.maybeSingle = async () => h.link;
  return { createClient: () => ({ from: () => builder }) };
});

vi.mock("@/lib/commercial/slack-notify", () => ({ postCommercialSlack: async () => {} }));

vi.mock("@/lib/salesforce/tomco-queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/salesforce/tomco-queue")>();
  return {
    ...actual,
    claimPending: async () => {
      const next = h.toClaim.shift();
      return next ? [next] : [];
    },
    peekPending: async () => [],
    markDone: async (id: string, outcome: string) => void h.markDone.push({ id, outcome }),
    markHeld: async (id: string, reason: string, opts = {}) => void h.markHeld.push({ id, reason, opts }),
    markFailed: async (id: string, _a: number, error: string) => void h.markFailed.push({ id, error }),
    markVerifyFailed: async () => {},
    nudgeChangeOrdersWaitingOnSale: async () => {},
  };
});

vi.mock("@/lib/salesforce/tomco-pairing", () => ({
  isSoldStatus: () => true,
  listOpenSalesforceCandidates: async () => [],
  listResolvedDeals: async () => new Map(),
  loadSoldDeal: async () => h.loaded,
}));

vi.mock("@/lib/salesforce/tomco-decide", () => ({ decideWriteBack: () => h.plan }));

vi.mock("@/lib/salesforce/tomco-writeback", () => ({
  CREATED_LINK_NOTE: "created by the Tomco write-back",
  createNew: async () => {
    h.writes.push("createNew");
    return { action: "created", checks: [{ name: "x", ok: true, detail: "" }], steps: ["created"] };
  },
  updateExisting: async () => {
    h.writes.push("updateExisting");
    return { action: "updated", checks: [{ name: "x", ok: true, detail: "" }], steps: ["updated"] };
  },
}));

vi.mock("@/lib/salesforce/tomco-changeorder", () => ({
  CO_MAP_ENTITY: "change_order_record",
  ROLLUP_TITLE: /^approved change orders$/i,
  syncChangeOrder: async () => h.coResult,
}));

const { runWriteBackTick } = await import("@/lib/salesforce/tomco-tick");

const sale = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  kind: "sale",
  opportunityId: "22222222-2222-4222-8222-222222222222",
  changeOrderId: null,
  attempts: 0,
  queuedAt: new Date().toISOString(),
  ...over,
});
const soldDeal = {
  deal: { id: "22222222-2222-4222-8222-222222222222", title: "Job", accountName: null, contractCents: 100, decidedAt: null },
  createdAt: "2026-10-15T00:00:00Z",
  sold: true,
};

beforeEach(() => {
  h.markDone.length = 0;
  h.markHeld.length = 0;
  h.markFailed.length = 0;
  h.writes.length = 0;
  h.toClaim.length = 0;
  h.link = { data: null, error: null };
  h.loaded = soldDeal;
  h.plan = { action: "insert", why: "new" };
});

describe("F23 b — a failed link read is never 'not linked'", () => {
  it("🔴 spends an attempt and writes NOTHING to Salesforce", async () => {
    h.link = { data: null, error: { message: "upstream request timeout" } };
    h.toClaim.push(sale());
    const out = await runWriteBackTick({ apply: true, limit: 1 });
    expect(h.writes).toEqual([]);
    expect(out.failed).toBe(1);
    expect(h.markFailed[0].error).toMatch(/could not read this deal's Salesforce link/);
  });

  it("…whereas a clean 'no link' read does reach the insert path — so the line above is not vacuous", async () => {
    h.toClaim.push(sale());
    await runWriteBackTick({ apply: true, limit: 1 });
    expect(h.writes).toEqual(["createNew"]);
  });
});

describe("F24 — a deal deleted here", () => {
  it("🔴 that Salesforce still holds is HELD for a person, never done, never written", async () => {
    h.loaded = null;
    h.link = { data: { sf_id: "006000000000001AAA", notes: null }, error: null };
    h.toClaim.push(sale());
    const out = await runWriteBackTick({ apply: true, limit: 1 });
    expect(out.held).toBe(1);
    expect(h.markDone).toEqual([]);
    expect(h.writes).toEqual([]);
    expect(h.markHeld[0].opts.waitsFor).toBe("person");
    expect(h.markHeld[0].reason).toMatch(/deleted here, but Salesforce still holds it \(006000000000001AAA\)/);
  });

  it("that Salesforce never had is simply finished", async () => {
    h.loaded = null;
    h.toClaim.push(sale());
    await runWriteBackTick({ apply: true, limit: 1 });
    expect(h.markDone[0].outcome).toMatch(/never had it/);
    expect(h.markHeld).toEqual([]);
  });

  it("whose link cannot be read is a failure, not a finish", async () => {
    h.loaded = null;
    h.link = { data: null, error: { message: "timeout" } };
    h.toClaim.push(sale());
    await runWriteBackTick({ apply: true, limit: 1 });
    expect(h.markDone).toEqual([]);
    expect(h.markFailed).toHaveLength(1);
  });
});

describe("F38 — what a hold waits for", () => {
  it("a 'might be the same sale' hold is parked for a person", async () => {
    h.plan = { action: "hold", why: "one open estimate looks like this job", candidates: [], othersChecked: 0 };
    h.toClaim.push(sale());
    await runWriteBackTick({ apply: true, limit: 1 });
    expect(h.markHeld[0].opts.waitsFor).toBe("person");
  });

  it("a change order waiting for its sale keeps the event clock", async () => {
    h.toClaim.push(sale({ kind: "change_order", changeOrderId: "33333333-3333-4333-8333-333333333333" }));
    await runWriteBackTick({ apply: true, limit: 1 });
    expect(h.markHeld[0].opts.waitsFor).toBe("event");
  });

  it("🔴 …until it has waited a day, when a person is asked instead of re-asking the org every hour for ever", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    h.toClaim.push(sale({ kind: "change_order", changeOrderId: "33333333-3333-4333-8333-333333333333", queuedAt: twoDaysAgo }));
    await runWriteBackTick({ apply: true, limit: 1 });
    expect(h.markHeld[0].opts.waitsFor).toBe("person");
    expect(h.markHeld[0].reason).toMatch(/Still waiting after a day/);
  });
});
