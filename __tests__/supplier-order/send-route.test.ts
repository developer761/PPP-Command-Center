import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The send route had no executed test either (mutation testing, 2026-09-17).
 * Every mutation survived, including one that matters a great deal:
 *
 *   .from("customer_form_tokens")
 *     .update({ vendor_email_sent_at: … })
 *     .eq("work_order_id", body.workOrderId)     ← delete this line
 *
 * Without the filter, sending ONE vendor order stamps every color-form token
 * in the table. That stamp is what tells a customer their color change came
 * too late, so every customer on every open job would be told their paint was
 * already bought.
 *
 * This drives the real POST handler over a recording stub and asserts on what
 * it actually writes.
 */

type Op = {
  table: string;
  kind: "select" | "insert" | "update";
  values?: Record<string, unknown>;
  filters: Array<[string, string]>;
};

const ops: Op[] = [];
let insertError: { code: string; message: string } | null = null;
const sent: Array<{ subject?: string; body?: string }> = [];

function chain(op: Op, result: () => { data: unknown; error: unknown }) {
  const self = {
    select: () => self,
    eq: (col: string, val: string) => {
      op.filters.push([col, val]);
      return self;
    },
    maybeSingle: async () => result(),
    single: async () => result(),
    // `await sbAdmin.from(…).update(…).eq(…)` has no terminal call.
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(res, rej),
  };
  return self;
}

const stub = {
  from: (table: string) => ({
    select: () => {
      const op: Op = { table, kind: "select", filters: [] };
      ops.push(op);
      // No existing draft row — the route takes the INSERT path.
      return chain(op, () => ({ data: null, error: null }));
    },
    insert: (values: Record<string, unknown>) => {
      const op: Op = { table, kind: "insert", values, filters: [] };
      ops.push(op);
      const first = ops.filter((o) => o.kind === "insert").length === 1;
      return chain(op, () =>
        insertError && first
          ? { data: null, error: insertError }
          : { data: { id: "so-1" }, error: null }
      );
    },
    update: (values: Record<string, unknown>) => {
      const op: Op = { table, kind: "update", values, filters: [] };
      ops.push(op);
      return chain(op, () => ({ data: null, error: null }));
    },
  }),
};

vi.mock("@supabase/supabase-js", () => ({ createClient: () => stub }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "katie@precisionpaintingplus.com" } } }) },
  }),
}));
vi.mock("@/lib/auth/profile", () => ({
  getProfileByUserId: async () => ({ id: "u1", role: "admin", is_admin: true, is_active: true }),
}));
vi.mock("@/lib/auth/admin", () => ({ isAdminEmail: () => true }));
vi.mock("@/lib/email/resend", () => ({
  sendEmail: vi.fn(async (msg: { subject?: string; text?: string }) => {
    sent.push({ subject: msg.subject, body: msg.text });
    return { ok: true, id: "resend-1" };
  }),
}));
vi.mock("@/lib/alerts/materials-alerts", () => ({ alertMaterialsFailure: async () => {} }));
/** What the route asked the allocator for. */
const poArgs: Array<[string, string]> = [];
vi.mock("@/lib/supplier-order/builder", () => ({
  nextPoNumber: async (woId: string, woNumber: string) => {
    poArgs.push([woId, woNumber]);
    return "00300099-2";
  },
}));

const { POST } = await import("@/app/api/admin/supplier-order/send/route");

const WO = "0WOwj0000012345";

function send(over: Record<string, unknown> = {}) {
  return POST(
    new Request("http://x/api/admin/supplier-order/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workOrderId: WO,
        workOrderNumber: "00300099",
        supplierAccountId: "001STORE",
        supplierName: "Aboffs",
        poNumber: "00300099",
        subject: "PPP Materials Order — PO 00300099",
        body: "PO Number: 00300099\n\n3 gal — Regal Select — White Dove",
        sentToEmail: "orders@aboffs.test",
        fulfillmentMethod: "pickup",
        pickupLocation: "Aboffs Huntington",
        lineItems: [{ room: "Living Room" }],
        paintOrdered: true,
        extras: [],
        ...over,
      }),
    })
  );
}

const stamps = () =>
  ops.filter((o) => o.table === "customer_form_tokens" && o.kind === "update");

beforeEach(() => {
  ops.length = 0;
  sent.length = 0;
  insertError = null;
  poArgs.length = 0;
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://stub";
  process.env.SUPABASE_SECRET_KEY ??= "stub";
});

describe("telling the color form that the paint has been bought", () => {
  it("stamps this work order's tokens and NO others", async () => {
    const res = await send();
    expect(res.status).toBe(200);
    expect(stamps()).toHaveLength(1);
    expect(stamps()[0].values).toHaveProperty("vendor_email_sent_at");
    // The filter is the whole point: without it, one vendor order tells every
    // customer on every open job that their colors came too late.
    expect(stamps()[0].filters).toEqual([["work_order_id", WO]]);
  });

  it("says nothing when the order carried no paint", async () => {
    // Rollers, tape and drop cloths are not "your paint has been ordered".
    await send({ paintOrdered: false });
    expect(stamps()).toHaveLength(0);
  });
});

describe("a PO number that was taken between drafting and sending", () => {
  it("retries with a fresh one and sends THAT number to the vendor", async () => {
    insertError = { code: "23505", message: 'duplicate key value violates unique constraint "supplier_orders_po_number_key"' };
    const res = await send();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ poNumber: "00300099-2" });
    // The row stores -2 …
    const inserts = ops.filter((o) => o.kind === "insert");
    expect(inserts).toHaveLength(2);
    expect(inserts[1].values?.po_number).toBe("00300099-2");
    // … and so do the subject and the body. A row saying -2 under an email
    // saying -1 is the same defect one layer down.
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain("00300099-2");
    expect(sent[0].body).toContain("PO Number: 00300099-2");
    // And the rewritten copy is persisted, or Mail Hub renders the stale text.
    const drafts = ops.filter((o) => o.table === "supplier_orders" && o.kind === "update" && "draft_body" in (o.values ?? {}));
    expect(String(drafts.at(-1)?.values?.draft_body ?? "")).toContain("00300099-2");
  });

  it("still allocates a number when the work order number is missing", async () => {
    // `?? ""` here would hand the allocator a blank base, and the builder's own
    // fallback is the record's last six characters — the retry has to match it
    // or the recovery stores an order nobody can quote. Untested until now.
    insertError = { code: "23505", message: 'duplicate key value violates unique constraint "supplier_orders_po_number_key"' };
    const res = await send({ workOrderNumber: null });
    expect(res.status).toBe(200);
    expect(poArgs.at(-1)).toEqual([WO, WO.slice(-6)]);
  });

  it("only recovers from a PO collision, not from a concurrent draft", async () => {
    // The one-open-draft-per-vendor constraint IS a real conflict between two
    // admins, and refreshing is the right advice there.
    insertError = { code: "23505", message: 'duplicate key value violates unique constraint "one_open_draft_per_supplier"' };
    const res = await send();
    expect(res.status).toBe(409);
    expect(sent).toHaveLength(0);
  });
});
