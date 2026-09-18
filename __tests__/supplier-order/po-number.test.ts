import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * R5.6 — "You can't send another order once you've cancelled one."
 *
 * `supplier_orders.po_number` is globally UNIQUE. The allocator COUNTED a work
 * order's orders while excluding cancelled ones, so:
 *
 *   send    → 0 existing            → "00314545"
 *   cancel  → status='cancelled', but the row still holds that PO
 *   send    → cancelled excluded, count back to 0 → "00314545"
 *           → 23505 on a number the cancelled row owns
 *
 * Every retry recomputed the same number, so the work order could never take
 * another order. Kate: "it isn't a transient conflict that clears on its own."
 * Confirmed in production — WO 00314545 was sitting in exactly that state.
 *
 * This file used to re-implement the allocation rule and assert on its own
 * copy, plus grep the source for `.select("po_number")`. Mutation testing
 * (2026-09-17) showed the real function was never called: deleting the
 * `!taken.has(base)` guard — the production bug above — left it green. So it
 * now runs `nextPoNumber` against a stubbed table and asserts what it hands
 * back.
 */

/** Whatever the next `select(...).eq(...)` should resolve to. */
let rows: Array<{ po_number: string | null }> = [];
let selectError: { message: string } | null = null;
const calls: Array<{ table: string; columns: string; eq: [string, string] }> = [];

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: (col: string, val: string) => {
          calls.push({ table, columns, eq: [col, val] });
          return Promise.resolve({ data: selectError ? null : rows, error: selectError });
        },
      }),
    }),
  }),
}));

const { nextPoNumber } = await import("@/lib/supplier-order/builder");

const WO = "0WO000000000001";
const NUM = "00314545";
const taken = (...po: string[]) => {
  rows = po.map((p) => ({ po_number: p }));
};

beforeEach(() => {
  rows = [];
  selectError = null;
  calls.length = 0;
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://stub";
  process.env.SUPABASE_SECRET_KEY ??= "stub";
});

describe("PO allocation", () => {
  it("uses the bare work order number on a first order", async () => {
    await expect(nextPoNumber(WO, NUM)).resolves.toBe(NUM);
  });

  it("does not reissue a CANCELLED order's number", async () => {
    // The production state that bricked the work order: the row is cancelled,
    // but it still owns that PO, and the column is globally unique.
    taken(NUM);
    await expect(nextPoNumber(WO, NUM)).resolves.toBe(`${NUM}-2`);
  });

  it("skips past every number the work order has used", async () => {
    taken(NUM, `${NUM}-2`, `${NUM}-3`);
    await expect(nextPoNumber(WO, NUM)).resolves.toBe(`${NUM}-4`);
  });

  it("fills a gap rather than colliding with a later number", async () => {
    taken(NUM, `${NUM}-3`);
    await expect(nextPoNumber(WO, NUM)).resolves.toBe(`${NUM}-2`);
  });

  it("counts the old PPP-WO spelling as the same job", async () => {
    // Orders placed before the rename still hold `PPP-WO00314545`. Ignoring
    // them restarts at the bare number, which then collides on the unique
    // index — the same dead end by another route.
    taken(`PPP-WO${NUM}`);
    await expect(nextPoNumber(WO, NUM)).resolves.toBe(`${NUM}-2`);
    taken(`PPP-WO${NUM}`, `PPP-WO${NUM}-2`);
    await expect(nextPoNumber(WO, NUM)).resolves.toBe(`${NUM}-3`);
  });

  it("ignores blank and null PO columns", async () => {
    rows = [{ po_number: null }, { po_number: "   " }];
    await expect(nextPoNumber(WO, NUM)).resolves.toBe(NUM);
  });

  it("asks for the numbers in use on THIS work order, not a count", async () => {
    await nextPoNumber(WO, NUM);
    expect(calls).toEqual([
      { table: "supplier_orders", columns: "po_number", eq: ["work_order_id", WO] },
    ]);
  });

  it("falls back to a timestamp suffix when the lookup fails", async () => {
    // Never the bare number: that is the one most likely to be taken, and a
    // send that dead-ends is what this whole rule exists to prevent.
    selectError = { message: "connection refused" };
    const po = await nextPoNumber(WO, NUM);
    expect(po).not.toBe(NUM);
    expect(po).toMatch(new RegExp(`^${NUM}-t\\d{6}$`));
  });
});
