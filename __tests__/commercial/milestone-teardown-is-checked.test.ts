import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSupabase, type Call, type Answer } from "../helpers/fake-supabase";

/**
 * Removing or editing a milestone moves three things that must agree: the
 * milestone row, its paired charge on the invoice, and — for a change-order
 * milestone — the CO's claim. None of those writes used to be read, and the CO
 * was freed FIRST, so any later failure left the charge on the invoice with the
 * CO reading un-billed: billable twice. A failed payment retag stranded cash on
 * a hidden milestone. A failed line write on edit left the schedule and the
 * invoice total disagreeing while it said "saved".
 */

let respond: (c: Call) => Answer | undefined = () => undefined;
const calls: Call[] = [];

const removeLineItem = vi.fn(async () => ({ ok: true }) as { ok: boolean; error?: string });
const recomputeSubtotal = vi.fn(async () => ({ ok: true }) as { ok: true } | { ok: false; error: string });

vi.mock("@/lib/commercial/db", () => ({
  commercialDb: () => fakeSupabase((c) => respond(c), calls).client,
}));
vi.mock("@/lib/commercial/invoices/db", () => ({
  addLineItem: vi.fn(),
  removeLineItem: (...a: unknown[]) => removeLineItem(...(a as [])),
  listInvoiceLineItems: vi.fn(async () => []),
  getCommercialInvoice: vi.fn(async (id: string) => ({ id, status: "draft", opportunity_id: "opp-1", invoice_number: "INV-7" })),
  recomputeSubtotal: (...a: unknown[]) => recomputeSubtotal(...(a as [])),
}));
vi.mock("@/lib/commercial/documents/db", () => ({
  uploadDocument: vi.fn(),
  getDocumentsByIds: vi.fn(async () => new Map()),
  softDeleteDocument: vi.fn(async () => ({ ok: true })),
}));

const MS = {
  id: "ms1",
  invoice_id: "inv1",
  name: "Phase 1",
  amount_cents: 10_000,
  line_item_id: "li1",
  change_order_id: "co1",
  lien_waiver_document_id: null,
  deleted_at: null,
};

type Script = { retag?: Answer; hide?: Answer; lineDel?: Answer; claim?: Answer; liUpdate?: Answer; msUpdate?: Answer };

function script(s: Script) {
  let msUpdates = 0;
  respond = (c) => {
    if (c.table === "commercial_invoice_milestones") {
      if (c.op === "select") return { data: MS };
      if (c.op === "update") {
        const p = c.payload as Record<string, unknown>;
        if ("deleted_at" in p) return s.hide ?? { data: [{ id: "ms1" }] };
        msUpdates += 1;
        // First update is the edit itself; a second is the revert.
        return msUpdates === 1 ? (s.msUpdate ?? { data: { ...MS, ...p } }) : { data: [{ id: "ms1" }] };
      }
    }
    if (c.table === "commercial_invoice_payments") {
      if (c.op === "select") return { data: [] };
      if (c.op === "update") return s.retag ?? { data: null };
    }
    if (c.table === "commercial_invoice_line_items") {
      if (c.op === "delete") return s.lineDel ?? { data: null };
      if (c.op === "update") return s.liUpdate ?? { data: [{ id: "li1" }] };
    }
    if (c.table === "commercial_change_orders" && c.op === "update") return s.claim ?? { data: null };
    return undefined;
  };
}

const claimWrites = () => calls.filter((c) => c.table === "commercial_change_orders" && c.op === "update");
const hides = () => calls.filter((c) => c.table === "commercial_invoice_milestones" && c.op === "update" && "deleted_at" in (c.payload as object));

describe("deleteMilestone", () => {
  beforeEach(() => {
    calls.length = 0;
    removeLineItem.mockReset().mockResolvedValue({ ok: true });
    recomputeSubtotal.mockReset().mockResolvedValue({ ok: true });
  });
  const del = async () => (await import("@/lib/commercial/invoices/milestones")).deleteMilestone("ms1", "u1");

  it("frees the change order only after the milestone and its charge are gone", async () => {
    script({});
    const r = await del();
    expect(r.ok).toBe(true);
    expect(claimWrites()).toHaveLength(1);
    expect(calls.indexOf(claimWrites()[0])).toBeGreaterThan(calls.indexOf(hides()[0]));
  });

  it("removes nothing when the payments can't be moved onto the invoice", async () => {
    script({ retag: { error: { message: "boom" } } });
    const r = await del();
    expect(r.ok).toBe(false);
    expect(hides()).toHaveLength(0);
    expect(claimWrites()).toHaveLength(0);
  });

  it("keeps the CO billed when the charge couldn't be taken off", async () => {
    // Both the sanctioned removal AND the direct fallback fail: the charge is
    // still on the invoice, so the CO must not read as free to bill again.
    removeLineItem.mockResolvedValue({ ok: false, error: "change_order_line" });
    script({ lineDel: { error: { message: "boom" } } });
    const r = await del();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/charge is still on the invoice/);
    expect(claimWrites()).toHaveLength(0);
  });

  it("says the total may be stale when only the re-total failed", async () => {
    removeLineItem.mockResolvedValue({ ok: false, error: "re-total" });
    recomputeSubtotal.mockResolvedValue({ ok: false, error: "re-total failed" });
    script({});
    const r = await del();
    // A SUCCESS with a warning: the milestone and its charge are gone. As
    // ok:false the CO rollback read it as "charge still on the invoice — billed
    // twice", and tick-off skipped its notice and empty-draft cleanup.
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.totalStale).toBe(true);
      expect(r.warning).toMatch(/total couldn't be re-added/);
    }
    expect(claimWrites()).toHaveLength(1); // the charge is gone; free the CO
  });

  it("reports a failed claim release", async () => {
    script({ claim: { error: { message: "boom" } } });
    const r = await del();
    expect(r.ok).toBe(false);
  });
});

describe("updateMilestone", () => {
  beforeEach(() => {
    calls.length = 0;
    recomputeSubtotal.mockReset().mockResolvedValue({ ok: true });
  });
  const edit = async () => (await import("@/lib/commercial/invoices/milestones")).updateMilestone("ms1", { name: "Phase 1A" }, "u1");

  it("puts the milestone back and says nothing changed when its charge can't be updated", async () => {
    script({ liUpdate: { error: { message: "boom" } } });
    const r = await edit();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/nothing was changed/);
    const msWrites = calls.filter((c) => c.table === "commercial_invoice_milestones" && c.op === "update");
    expect(msWrites).toHaveLength(2);
    expect((msWrites[1].payload as { name: string }).name).toBe("Phase 1");
  });

  it("reports a failed re-total instead of 'saved'", async () => {
    script({});
    recomputeSubtotal.mockResolvedValue({ ok: false, error: "re-total failed" });
    const r = await edit();
    expect(r.ok).toBe(false);
  });

  it("saves when both writes land", async () => {
    script({});
    const r = await edit();
    expect(r.ok).toBe(true);
  });
});
