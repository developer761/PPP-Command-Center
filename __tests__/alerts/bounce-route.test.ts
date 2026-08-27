import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Drives the REAL webhook handler, with only Supabase and the alert dispatcher
 * stubbed.
 *
 * Why not against the live database: every supplier order and colour form in
 * production is currently `delivered`, so replaying a bounce at any of them
 * would flip a live job to "bounced" — wrong data on a real job, to prove a
 * test point. The column NAMES are verified separately against the live tables
 * (a bad column errors there rather than returning empty), which leaves this to
 * cover the branch logic those columns feed.
 *
 * That split matters because the one bug this code has already had was a column
 * that existed on the other table — `sent_to_email` on supplier_orders, but
 * `customer_email` on customer_form_tokens.
 */

const alertMaterialsFailure = vi.fn();

type Row = Record<string, unknown> | null;
function stubSupabase(order: Row, token: Row) {
  const updated: Array<{ table: string; values: Record<string, unknown> }> = [];
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self, eq: self, not: self, order: self, limit: self,
        maybeSingle: async () => ({
          data: table === "supplier_orders" ? order : token,
          error: null,
        }),
        update(values: Record<string, unknown>) {
          updated.push({ table, values });
          return { eq: async () => ({ error: null }) };
        },
      });
      return chain;
    },
  };
  return { client, updated };
}

let supa = stubSupabase(null, null);

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supa.client,
}));
vi.mock("@/lib/alerts/materials-alerts", () => ({ alertMaterialsFailure }));

const post = async (body: unknown) => {
  const { POST } = await import("@/app/api/webhooks/resend-events/route");
  return POST(new Request("http://localhost/api/webhooks/resend-events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
};

const bounce = (id: string) => ({
  type: "email.bounced",
  data: { email_id: id, bounce: { type: "Permanent", message: "550 mailbox does not exist" } },
});

beforeEach(() => {
  vi.resetModules();
  alertMaterialsFailure.mockReset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "stub";
  delete process.env.RESEND_EVENTS_SECRET;   // unsigned path, dev-only branch
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("a bounced supplier order reaches Slack with something Kate can act on", () => {
  it("names the PO, the vendor, the address and the reason", async () => {
    supa = stubSupabase(
      { id: "so-1", delivery_status: "delivered", po_number: "PPP-1042",
        supplier_name: "Benjamin Moore — Huntington", sent_to_email: "orders@bm.example",
        work_order_number: "00306643" },
      null
    );
    await post(bounce("msg-1"));
    expect(alertMaterialsFailure).toHaveBeenCalledTimes(1);
    const a = alertMaterialsFailure.mock.calls[0][0];
    expect(a.kind).toBe("supplier_order_bounced");
    expect(a.workOrder).toBe("00306643");
    expect(a.detail.PO).toBe("PPP-1042");
    expect(a.detail.Vendor).toContain("Benjamin Moore");
    expect(a.detail["Sent to"]).toBe("orders@bm.example");
    expect(String(a.detail.Reason)).toContain("550");
  });

  it("a bounced colour form reads customer_email, not sent_to_email", async () => {
    // The exact bug this had once: `sent_to_email` exists on supplier_orders and
    // NOT on customer_form_tokens. Selecting it errored, the handler returns 200
    // by design so Resend stops retrying, and the alert silently never fired.
    supa = stubSupabase(null, {
      token: "tok-1", delivery_status: "delivered", work_order_number: "00306644",
      customer_name: "M. Whitfield", customer_email: "m@example.com",
    });
    await post(bounce("msg-2"));
    const a = alertMaterialsFailure.mock.calls[0][0];
    expect(a.kind).toBe("color_form_bounced");
    expect(a.detail["Sent to"]).toBe("m@example.com");
    expect(a.summary).toContain("waiting on colours");
  });

  it("still alerts when a bounce matches nothing", async () => {
    supa = stubSupabase(null, null);
    await post(bounce("msg-orphan"));
    expect(alertMaterialsFailure).toHaveBeenCalledTimes(1);
    expect(alertMaterialsFailure.mock.calls[0][0].kind).toBe("unexpected_error");
  });

  it("treats a spam complaint as a failure too", async () => {
    supa = stubSupabase({ id: "so-2", delivery_status: "delivered", po_number: "PPP-2",
      supplier_name: "V", sent_to_email: "v@x.test", work_order_number: "WO-2" }, null);
    await post({ type: "email.complained", data: { email_id: "msg-3" } });
    expect(alertMaterialsFailure).toHaveBeenCalledTimes(1);
  });

  it("stays quiet on a successful delivery", async () => {
    // Noisy was the instruction; noisy about SUCCESS is just noise.
    supa = stubSupabase({ id: "so-3", delivery_status: "sent", po_number: "PPP-3",
      supplier_name: "V", sent_to_email: "v@x.test", work_order_number: "WO-3" }, null);
    await post({ type: "email.delivered", data: { email_id: "msg-4" } });
    expect(alertMaterialsFailure).not.toHaveBeenCalled();
  });

  it("does not alert on an open or a click", async () => {
    supa = stubSupabase(null, { token: "t", delivery_status: "sent", work_order_number: "W",
      customer_name: "C", customer_email: "c@x.test" });
    await post({ type: "email.opened", data: { email_id: "msg-5" } });
    await post({ type: "email.clicked", data: { email_id: "msg-6" } });
    expect(alertMaterialsFailure).not.toHaveBeenCalled();
  });

  it("always answers 200, so Resend stops retrying", async () => {
    supa = stubSupabase(null, null);
    const res = await post(bounce("msg-7"));
    expect(res.status).toBe(200);
  });
});
