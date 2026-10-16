import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSupabase, type Call, type Answer } from "../helpers/fake-supabase";

/**
 * Bulk invoice delete voids the paid invoices first, then soft-deletes the lot.
 * Its three copies read none of their writes: a failed void still deleted the
 * paid invoices (no void record), a failed delete still announced
 * "N invoices deleted" (N = attempted), and the audit rows recorded deletions
 * that never happened. The shared helper drives every later step from the ids
 * the database actually returned.
 */

let respond: (c: Call) => Answer | undefined = () => undefined;
const calls: Call[] = [];
const logDelete = vi.fn(async () => {});
const release = vi.fn(async () => 0);

vi.mock("@/lib/commercial/db", () => ({
  commercialDb: () => fakeSupabase((c) => respond(c), calls).client,
}));
vi.mock("@/lib/commercial/audit-log", () => ({ logDelete: (...a: unknown[]) => logDelete(...(a as [])) }));
vi.mock("@/lib/commercial/invoices/status", () => ({
  releaseTickedChangeOrders: (...a: unknown[]) => release(...(a as [])),
}));

const ROWS = [
  { id: "paid-1", status: "partial", paid_cents: 25_000 },
  { id: "draft-1", status: "draft", paid_cents: 0 },
];

type Script = { read?: Answer; voidRes?: Answer; delRes?: Answer; log?: Answer };

function script(s: Script) {
  respond = (c) => {
    if (c.table === "commercial_invoices") {
      if (c.op === "select") return c.single ? { data: { id: "x" } } : (s.read ?? { data: ROWS });
      if (c.op === "update") {
        const p = c.payload as Record<string, unknown>;
        if (p.status === "void") return s.voidRes ?? { data: [{ id: "paid-1" }] };
        if ("deleted_at" in p) {
          if (s.delRes) return s.delRes;
          const ids = c.filters.find(([m, col]) => m === "in" && col === "id")?.[2] as string[];
          return { data: ids.map((id) => ({ id })) };
        }
      }
    }
    if (c.table === "commercial_invoice_status_log") return s.log ?? { data: null };
    return undefined;
  };
}

const deleteWrites = () => calls.filter((c) => c.table === "commercial_invoices" && c.op === "update" && "deleted_at" in (c.payload as object));

async function run() {
  const { bulkVoidAndDeleteInvoices } = await import("@/lib/commercial/invoices/bulk-delete");
  return bulkVoidAndDeleteInvoices({ column: "opportunity_id", id: "opp-1" }, "u1", "test");
}

describe("bulk invoice delete", () => {
  beforeEach(() => {
    calls.length = 0;
    logDelete.mockClear();
    release.mockClear();
  });

  it("voids, deletes and audits everything when it all lands", async () => {
    script({});
    const r = await run();
    expect(r).toEqual({ ok: true, deleted: 2 });
    expect(logDelete).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("deletes NOTHING when the void of the paid invoices fails", async () => {
    script({ voidRes: { data: null, error: { message: "boom" } } });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(deleteWrites()).toHaveLength(0);
  });

  it("never deletes a paid invoice whose void didn't land", async () => {
    script({ voidRes: { data: [] } });
    const r = await run();
    const ids = deleteWrites()[0].filters.find(([m, c]) => m === "in" && c === "id")?.[2];
    expect(ids).toEqual(["draft-1"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.deleted).toBe(1);
      expect(r.warning).toMatch(/1 invoice wasn't deleted/);
    }
  });

  it("reports zero deleted — not the attempted count — when the delete fails", async () => {
    script({ delRes: { data: null, error: { message: "boom" } } });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.deleted).toBe(0);
    if (!r.ok) expect(r.error).toMatch(/voided but not deleted/);
    expect(logDelete).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("counts and audits only the rows the database returned", async () => {
    script({ delRes: { data: [{ id: "draft-1" }] } });
    const r = await run();
    expect(r.deleted).toBe(1);
    expect(logDelete).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith("draft-1");
  });

  it("changes nothing when the invoices can't be read", async () => {
    script({ read: { data: null, error: { message: "timeout" } } });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(calls.filter((c) => c.op !== "select")).toHaveLength(0);
  });
});
