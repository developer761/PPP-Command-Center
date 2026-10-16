import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSupabase, type Call, type Answer } from "../helpers/fake-supabase";

/**
 * Taking a change order off an invoice is two facts that must move together:
 * the CHARGE leaves the invoice, and the CO's claim (`invoiced_invoice_id`)
 * clears so it can be billed again. The untick used to delete the line and
 * re-total without reading either result, then clear the claim regardless —
 * so a failed delete left the charge on the invoice while the CO read as
 * un-billed, and the Change Orders tool offered to bill it a second time.
 *
 * The lost-race rollback had the same hole from the other side: a failed peel
 * left the CO on THIS invoice as well as the winner's, and said only "billed
 * elsewhere".
 *
 * Mocked at the data boundary plus the sibling modules; the tick logic under
 * test is the real one.
 */

let respond: (c: Call) => Answer | undefined = () => undefined;
const calls: Call[] = [];

const recomputeSubtotal = vi.fn(async () => ({ ok: true }) as { ok: true } | { ok: false; error: string });
const deleteMilestone = vi.fn(async () => ({ ok: true, value: null }) as { ok: true; value: null } | { ok: false; error: string });

vi.mock("@/lib/commercial/db", () => ({
  commercialDb: () => fakeSupabase((c) => respond(c), calls).client,
}));
vi.mock("@/lib/commercial/audit-log", () => ({
  logInsert: vi.fn(async () => {}),
  logDelete: vi.fn(async () => {}),
  logUpdate: vi.fn(async () => {}),
}));
vi.mock("@/lib/commercial/invoices/db", () => ({
  getCommercialInvoice: vi.fn(async (id: string) => ({
    id,
    invoice_number: "INV-7",
    status: "draft",
    opportunity_id: "opp-1",
    deleted_at: null,
    notes: "Progress bill",
    balance_cents: 10_000,
    subtotal_cents: 10_000,
  })),
  recomputeSubtotal: (...a: unknown[]) => recomputeSubtotal(...(a as [])),
  addLineItem: vi.fn(async () => ({ ok: true })),
  createCommercialInvoice: vi.fn(),
  notifyCommercialInvoiceCreated: vi.fn(async () => {}),
  listCommercialInvoices: vi.fn(async () => []),
}));
vi.mock("@/lib/commercial/invoices/milestones", () => ({
  deleteMilestone: (...a: unknown[]) => deleteMilestone(...(a as [])),
  addMilestone: vi.fn(),
  listMilestonesForInvoice: vi.fn(async () => []),
}));
vi.mock("@/lib/commercial/opportunities/db", () => ({ getCommercialOpportunity: vi.fn() }));
vi.mock("@/lib/commercial/tax/db", () => ({ listTaxJurisdictions: vi.fn(async () => []) }));

type Script = {
  invoiced: string | null;
  ms?: Answer;
  line?: Answer;
  lineDel?: Answer;
  claim?: Answer;
};

function script(s: Script) {
  respond = (c) => {
    if (c.table === "commercial_change_orders") {
      if (c.op === "select")
        return {
          data: { id: "co1", opportunity_id: "opp-1", account_id: "acc-1", status: "approved", amount_cents: 5_000, invoiced_invoice_id: s.invoiced, co_number: 1, title: "Extra coat" },
        };
      if (c.op === "update") return s.claim ?? { data: { id: "co1" } };
    }
    if (c.table === "commercial_opportunities") return { data: { id: "opp-1", deleted_at: null } };
    if (c.table === "commercial_aia_applications") return { data: null, count: 0 };
    if (c.table === "commercial_invoice_milestones") return s.ms ?? { data: null };
    if (c.table === "commercial_invoice_line_items") {
      if (c.op === "select") return s.line ?? { data: { id: "li1" } };
      if (c.op === "delete") return s.lineDel ?? { data: null };
    }
    return undefined;
  };
}

const claimWrites = () => calls.filter((c) => c.table === "commercial_change_orders" && c.op === "update");
const lineDeletes = () => calls.filter((c) => c.table === "commercial_invoice_line_items" && c.op === "delete");

async function tick(on: boolean, target?: string) {
  const { setChangeOrderInvoiced } = await import("@/lib/commercial/change-orders/db");
  return setChangeOrderInvoiced("co1", on, "u1", target);
}

describe("taking a change order off an invoice", () => {
  beforeEach(() => {
    calls.length = 0;
    recomputeSubtotal.mockReset().mockResolvedValue({ ok: true });
    deleteMilestone.mockReset().mockResolvedValue({ ok: true, value: null });
  });

  it("frees the change order once its line is gone", async () => {
    script({ invoiced: "inv1" });
    const r = await tick(false);
    expect(r.ok).toBe(true);
    expect(lineDeletes()).toHaveLength(1);
    expect(claimWrites()).toHaveLength(1);
    // The claim is cleared AFTER the charge is removed, never before.
    expect(calls.indexOf(claimWrites()[0])).toBeGreaterThan(calls.indexOf(lineDeletes()[0]));
  });

  it("keeps the change order billed when its line couldn't be deleted", async () => {
    script({ invoiced: "inv1", lineDel: { error: { message: "boom" } } });
    const r = await tick(false);
    expect(r.ok).toBe(false);
    expect(claimWrites()).toHaveLength(0);
  });

  it("changes nothing when the line lookup itself fails", async () => {
    // An unread lookup error used to read as "no line" — and the claim was
    // then cleared with the charge still sitting on the invoice.
    script({ invoiced: "inv1", line: { data: null, error: { message: "timeout" } } });
    const r = await tick(false);
    expect(r.ok).toBe(false);
    expect(lineDeletes()).toHaveLength(0);
    expect(claimWrites()).toHaveLength(0);
  });

  it("still frees the CO when only the re-total fails, and says the total is stale", async () => {
    // The charge IS gone; holding the claim would strand the CO as billed
    // with nothing behind it.
    script({ invoiced: "inv1" });
    recomputeSubtotal.mockResolvedValue({ ok: false, error: "re-total failed" });
    const r = await tick(false);
    expect(claimWrites()).toHaveLength(1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/total couldn't be re-added/);
  });

  it("reports a failed claim release instead of success", async () => {
    script({ invoiced: "inv1", claim: { data: null, error: { message: "boom" } } });
    const r = await tick(false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/still shows as billed/);
  });

  it("surfaces a milestone teardown that failed", async () => {
    script({ invoiced: "inv1", ms: { data: { id: "ms1" } } });
    deleteMilestone.mockResolvedValue({ ok: false, error: "The milestone was removed, but its charge is still on the invoice." });
    const r = await tick(false);
    expect(r.ok).toBe(false);
    expect(claimWrites()).toHaveLength(0);
  });
});

describe("the lost-race rollback when ticking a change order on", () => {
  beforeEach(() => {
    calls.length = 0;
    recomputeSubtotal.mockReset().mockResolvedValue({ ok: true });
    deleteMilestone.mockReset().mockResolvedValue({ ok: true, value: null });
  });

  it("says the CO is now billed twice when the copy on this invoice couldn't be removed", async () => {
    script({ invoiced: null, claim: { data: null }, lineDel: { error: { message: "boom" } } });
    const r = await tick(true, "inv1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/billed twice/);
  });

  it("says only 'billed elsewhere' when the rollback did land", async () => {
    script({ invoiced: null, claim: { data: null } });
    const r = await tick(true, "inv1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/just billed elsewhere — refresh/);
  });

  it("surfaces a milestone rollback that failed — deleteMilestone RETURNS its failure", async () => {
    script({ invoiced: null, claim: { data: null }, ms: { data: { id: "ms1" } } });
    deleteMilestone.mockResolvedValue({ ok: false, error: "boom" });
    const r = await tick(true, "inv1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/billed twice/);
  });
});
