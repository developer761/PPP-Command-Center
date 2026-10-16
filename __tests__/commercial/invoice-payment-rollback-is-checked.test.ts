import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSupabase, type Call, type Answer } from "../helpers/fake-supabase";

/**
 * The invoice twin of the AIA guard: after a payment is inserted, the guard
 * re-reads the invoice's payments in a stable order and trims or removes the
 * part that over-collects. Every step used to be unread — a failed read became
 * `[]` (fail-open), and a failed trim or delete left the duplicate cash live
 * while the user was told it was capped, or that nothing was recorded.
 *
 * The invoice totals $1,000.00; the payment under test is $500.00.
 */

let respond: (c: Call) => Answer | undefined = () => undefined;
const calls: Call[] = [];

vi.mock("@/lib/commercial/db", () => ({
  commercialDb: () => fakeSupabase((c) => respond(c), calls).client,
}));
vi.mock("@/lib/commercial/audit-log", () => ({
  logInsert: vi.fn(async () => {}),
  logDelete: vi.fn(async () => {}),
  logUpdate: vi.fn(async () => {}),
}));
vi.mock("@/lib/notifications/after-response", () => ({ afterResponse: vi.fn() }));
vi.mock("@/lib/notifications/commercial-events", () => ({
  insertCommercialInvoiceCreatedNotifications: vi.fn(),
  insertCommercialInvoicePaymentRecordedNotifications: vi.fn(),
  insertCommercialInvoicePaidNotifications: vi.fn(),
}));

const INV = "inv-1";
const OURS = { id: "pay-new", invoice_id: INV, amount_cents: 50_000, created_at: "2026-10-16T12:00:01Z", milestone_id: null };
const EARLIER = (amount: number) => ({ id: "pay-old", invoice_id: INV, amount_cents: amount, created_at: "2026-10-16T12:00:00Z", milestone_id: null });

type Script = { allPays?: Answer; del?: Answer; trim?: Answer };

function script(s: Script) {
  respond = (c) => {
    if (c.table === "commercial_invoices" && c.op === "select") {
      return {
        data: { id: INV, status: "sent", balance_cents: 100_000, total_cents: 100_000, paid_cents: 50_000, invoice_number: "INV-1", opportunity_id: "opp-1" },
      };
    }
    if (c.table === "commercial_invoice_milestones") return { data: null, count: 0 };
    if (c.table === "commercial_invoice_payments") {
      if (c.op === "insert") return { data: OURS };
      if (c.op === "select") return s.allPays ?? { data: [OURS] };
      if (c.op === "delete") return s.del ?? { data: [{ id: OURS.id }] };
      if (c.op === "update") return s.trim ?? { data: [{ id: OURS.id }] };
    }
    return undefined;
  };
}

const removals = () => calls.filter((c) => c.table === "commercial_invoice_payments" && c.op === "delete");

async function pay() {
  const { addPayment } = await import("@/lib/commercial/invoices/db");
  return addPayment(INV, { amount_cents: 50_000, recorded_by_user_id: "u1" });
}

describe("the invoice over-collection guard checks its own writes", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("records normally when nothing raced it", async () => {
    script({});
    const r = await pay();
    expect(r.ok).toBe(true);
    expect(r.applied_cents).toBe(50_000);
    expect(removals()).toHaveLength(0);
  });

  it("does NOT fail open when the other payments can't be read", async () => {
    script({ allPays: { data: null, error: { message: "timeout" } } });
    const r = await pay();
    expect(r.ok).toBe(false);
    expect(removals()).toHaveLength(1);
    expect(r.error).toMatch(/was not recorded/);
  });

  it("says the payment IS on the invoice when removing a no-room duplicate fails", async () => {
    script({ allPays: { data: [EARLIER(100_000), OURS] }, del: { data: null, error: { message: "boom" } } });
    const r = await pay();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/IS on the invoice/);
  });

  it("reports a no-room duplicate it DID remove as nothing recorded", async () => {
    script({ allPays: { data: [EARLIER(100_000), OURS] } });
    const r = await pay();
    expect(r.ok).toBe(true);
    expect(r.applied_cents).toBe(0);
    expect(r.warning).toMatch(/nothing was recorded/);
  });

  it("takes the payment off when the trim fails, instead of keeping the full amount", async () => {
    script({ allPays: { data: [EARLIER(70_000), OURS] }, trim: { data: null, error: { message: "boom" } } });
    const r = await pay();
    expect(r.ok).toBe(false);
    expect(removals()).toHaveLength(1);
    expect(r.error).toMatch(/couldn't be reduced/);
  });

  it("treats a trim that matched no row as a failure", async () => {
    script({ allPays: { data: [EARLIER(70_000), OURS] }, trim: { data: [] } });
    const r = await pay();
    expect(r.ok).toBe(false);
  });
});
