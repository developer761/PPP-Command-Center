import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The inline-tax refold is the DEFAULT tax path on a certificate, and its
 * writes were fire-and-forget behind a `Promise<void>`.
 *
 * Issuing runs it immediately before freezing lines 1 and 2, so an update that
 * errored — or matched no row — froze the OLD tax-inclusive figure onto a
 * document the GC receives, with nothing on screen. That is Stephanie's "the
 * tax setting isn't sticking" (2026-09-24), and why she deleted a draft.
 *
 * Mocked at the DATA boundary only: the Supabase client, the proposal list
 * and the tax-rate lookup. The mode decision, the fold arithmetic and the
 * write check under test are the real ones.
 */

type Res = { data: unknown; error: { message: string } | null };
let updateResult: Res;
const updates: Array<Record<string, unknown>> = [];

function table(name: string) {
  const st: { op: string; payload?: Record<string, unknown> } = { op: "select" };
  const respond = (): Res => {
    if (name === "commercial_aia_applications") {
      return { data: { id: "app1", opportunity_id: "opp1", status: "draft" }, error: null };
    }
    if (st.op === "update") {
      updates.push(st.payload ?? {});
      return updateResult;
    }
    // ONE contract line, no legacy TAX row: the folded shape. Pre-tax $100.00
    // on a job that is now taxable, so the refold has to write $109.00.
    return {
      data: [{ id: "line1", item_no: "1", change_order_id: null, scheduled_value_cents: 100_00,
        from_previous_cents: 0, this_period_cents: 0, materials_stored_cents: 0 }],
      error: null,
    };
  };
  const b: Record<string, unknown> = {};
  const chain = (k: string) => (...args: unknown[]) => {
    if (k === "update") {
      st.op = "update";
      st.payload = args[0] as Record<string, unknown>;
    }
    return b;
  };
  for (const k of ["select", "eq", "in", "is", "order", "limit", "update"]) b[k] = chain(k);
  b.maybeSingle = () => Promise.resolve(respond());
  b.then = (ok: (r: Res) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(respond()).then(ok, bad);
  return b;
}

vi.mock("@/lib/commercial/db", () => ({ commercialDb: () => ({ from: (n: string) => table(n) }) }));
vi.mock("@/lib/commercial/aia/refold-deps", () => ({
  listProposalsForOpp: async () => [{ id: "p1", status: "won", total_cents: 100_00 }],
  listChangeOrders: async () => [],
}));
vi.mock("@/lib/commercial/proposals/proposal-tax-load", () => ({
  loadProposalTaxLine: async ({ priceCents }: { priceCents: number }) => ({
    taxCents: Math.round(priceCents * 0.09), label: "NYS Sales Tax (9%)",
  }),
}));

async function reconcile() {
  return (await import("@/lib/commercial/aia/sales-tax")).reconcileAiaTaxRow("app1");
}

describe("the tax refold says whether it landed", () => {
  beforeEach(() => {
    updates.length = 0;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("writes the tax-inclusive figure and reports success when the row came back", async () => {
    updateResult = { data: [{ id: "line1" }], error: null };
    const r = await reconcile();
    expect(updates).toEqual([{ scheduled_value_cents: 109_00 }]);
    expect(r).toEqual({ ok: true });
  });

  it("reports FAILURE when the update matched no row", async () => {
    updateResult = { data: [], error: null };
    const r = await reconcile();
    expect(updates).toHaveLength(1); // it did try — the miss is the point
    expect(r.ok).toBe(false);
  });

  it("reports FAILURE, in words, when the update errored", async () => {
    updateResult = { data: null, error: { message: "connection reset" } };
    const r = await reconcile();
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/sales tax.*connection reset/i);
  });
});
