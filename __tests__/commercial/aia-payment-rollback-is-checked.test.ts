import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSupabase, type Call, type Answer } from "../helpers/fake-supabase";

/**
 * The AIA payment over-collection guard takes duplicate cash back OUT. Each of
 * its writes used to go unread — and supabase RESOLVES with `{ error }`, it
 * does not throw — so a failed back-out left a second cheque live on the
 * certificate while the screen said nothing had landed, a failed trim kept the
 * full amount and reported success, and a failed read of the other payments
 * came back as `[]` and let everything through.
 *
 * Mocked at the DATA boundary only: the guard logic under test is the real
 * `recordAiaPayment`. The certificate is due $1,000.00.
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
vi.mock("@/lib/commercial/aia/db", () => ({
  resolveG702: vi.fn(async () => ({ totalEarnedLessRetainageCents: 100_000 })),
}));

const APP = "app-1";
const OURS = { id: "p-new", application_id: APP, amount_cents: 50_000, created_at: "2026-10-16T12:00:01Z", paid_at: "2026-10-16" };

type Script = {
  /** The guard's re-read of the live payments, AFTER our insert. */
  live?: Answer;
  backOut?: Answer;
  trim?: Answer;
};

function script(s: Script) {
  let paymentReads = 0;
  respond = (c) => {
    if (c.table === "commercial_aia_applications") {
      if (c.single) return { data: { id: APP, opportunity_id: "opp-1", application_number: 1, status: "submitted" } };
      return { data: [] };
    }
    if (c.table === "commercial_aia_payments") {
      if (c.op === "insert") return { data: OURS };
      if (c.op === "select") {
        paymentReads += 1;
        // First read is the pre-insert "already recorded" sum; the second is
        // the guard. Later reads are the status sync after success.
        if (paymentReads === 1) return { data: [] };
        if (paymentReads === 2) return s.live ?? { data: [OURS] };
        return { data: [OURS] };
      }
      if (c.op === "update") {
        const p = c.payload as Record<string, unknown>;
        if ("deleted_at" in p) return s.backOut ?? { data: { id: OURS.id } };
        if ("amount_cents" in p) return s.trim ?? { data: { ...OURS, amount_cents: p.amount_cents } };
      }
    }
    return undefined;
  };
}

const backOutWrites = () =>
  calls.filter((c) => c.table === "commercial_aia_payments" && c.op === "update" && "deleted_at" in (c.payload as object));

async function record() {
  const { recordAiaPayment } = await import("@/lib/commercial/aia/payments");
  return recordAiaPayment({ application_id: APP, amount_cents: 50_000, recorded_by_user_id: "u1" });
}

const EARLIER = (amount: number) => ({ id: "p-old", application_id: APP, amount_cents: amount, created_at: "2026-10-16T12:00:00Z", paid_at: "2026-10-16" });

describe("the AIA over-collection guard checks its own writes", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("records normally when nothing raced it", async () => {
    script({});
    const r = await record();
    expect(r.ok).toBe(true);
    expect(backOutWrites()).toHaveLength(0);
  });

  it("does NOT fail open when the other payments can't be read", async () => {
    // The old guard read through listAiaPayments, which answers [] on an
    // error: it saw an empty certificate and kept the payment, unverified.
    script({ live: { data: null, error: { message: "timeout" } } });
    const r = await record();
    expect(r.ok).toBe(false);
    expect(backOutWrites()).toHaveLength(1);
    if (!r.ok) expect(r.error).toMatch(/was not recorded/);
  });

  it("says the payment IS on the certificate when the back-out also fails", async () => {
    script({ live: { data: [EARLIER(100_000), OURS] }, backOut: { data: null, error: { message: "boom" } } });
    const r = await record();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/IS on the certificate/);
  });

  it("treats a back-out that matched no row as a failure, not success", async () => {
    script({ live: { data: [EARLIER(100_000), OURS] }, backOut: { data: null } });
    const r = await record();
    if (!r.ok) expect(r.error).toMatch(/IS on the certificate/);
    expect(r.ok).toBe(false);
  });

  it("takes the payment off when the trim fails, instead of keeping the full amount", async () => {
    // $700 already on a $1,000 certificate: ours may keep $300. The trim
    // failing used to leave all $500 live and report success.
    script({ live: { data: [EARLIER(70_000), OURS] }, trim: { data: null, error: { message: "boom" } } });
    const r = await record();
    expect(r.ok).toBe(false);
    expect(backOutWrites()).toHaveLength(1);
    if (!r.ok) expect(r.error).toMatch(/couldn't be reduced/);
  });

  it("keeps the trimmed amount when the trim lands", async () => {
    script({ live: { data: [EARLIER(70_000), OURS] } });
    const r = await record();
    expect(r.ok).toBe(true);
    if (r.ok) expect(Number(r.value.amount_cents)).toBe(30_000);
  });
});
