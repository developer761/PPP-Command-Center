import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Mary's purchases and vendor surfaces, at the seams (audit 2026-10-16).
 *
 * Every defect here was two halves that were each fine on their own:
 *
 *   · a credit stored negative, printed behind a hard-coded minus ("−-$153.87");
 *   · a reimbursed purchase edited into a credit, refused for the name the
 *     edit was clearing (`patch.reimburse_to ?? before.reimburse_to`);
 *   · Accounting's money-out forms saving the vendor as bare text — 44 rows,
 *     $50,091.06 since 2026-09-16 — because that path never called the
 *     directory resolver the Costs tool calls;
 *   · a vendor renamed in Settings, then a linked purchase edited without
 *     touching the name, silently unlinked;
 *   · the Purchases tab and its CSV pinned to one grouping, with no vendor.
 *
 * Mocked at the DATA boundary (the Supabase client, the audit log) so the
 * logic under test is the real one — never a spy on a sibling export, which an
 * intra-module call never goes through.
 */

// ── A tiny PostgREST stand-in: every chain method returns the chain; the
//    terminal reads come from per-table handlers the test sets. ──
type Handler = {
  maybeSingle?: (ctx: { op: string; payload: unknown; filters: [string, unknown][] }) => unknown;
  list?: (ctx: { op: string; payload: unknown; filters: [string, unknown][] }) => unknown[];
};
const tables: Record<string, Handler> = {};
const updates: { table: string; payload: unknown }[] = [];

function chain(table: string) {
  let op = "select";
  let payload: unknown = null;
  const filters: [string, unknown][] = [];
  const ctx = () => ({ op, payload, filters });
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "in", "order", "gt", "not", "gte", "limit", "range"]) {
    c[m] = (...a: unknown[]) => {
      if (m === "eq" || m === "in") filters.push([String(a[0]), a[1]]);
      return c;
    };
  }
  c.update = (p: unknown) => {
    op = "update";
    payload = p;
    updates.push({ table, payload: p });
    return c;
  };
  c.insert = (p: unknown) => {
    op = "insert";
    payload = p;
    return c;
  };
  c.maybeSingle = async () => ({ data: tables[table]?.maybeSingle?.(ctx()) ?? null, error: null });
  c.then = (res: (v: unknown) => unknown) =>
    Promise.resolve({ data: tables[table]?.list?.(ctx()) ?? [], error: null }).then(res);
  return c;
}

vi.mock("@/lib/commercial/db", () => ({ commercialDb: () => ({ from: (t: string) => chain(t) }) }));
vi.mock("@/lib/commercial/audit-log", () => ({
  logInsert: async () => {},
  logUpdate: async () => {},
  logDelete: async () => {},
}));
vi.mock("@/lib/commercial/documents/db", () => ({
  uploadDocument: async () => ({ ok: false, error: "not in tests" }),
  softDeleteDocument: async () => {},
}));

const OPP = "11111111-1111-4111-8111-111111111111";
const PUR = "22222222-2222-4222-8222-222222222222";
const VEN = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  updates.length = 0;
});

describe("a credit reads as a credit", () => {
  it("prints a cost with one minus and a credit as a credit", async () => {
    const { purchaseAmountLabel } = await import("@/lib/commercial/purchases/constants");
    expect(purchaseAmountLabel(15_387)).toBe("−$153.87");
    expect(purchaseAmountLabel(-15_387)).toBe("+$153.87 credit");
    // The double negative the cost list printed for all sixteen credits.
    expect(purchaseAmountLabel(-15_387)).not.toMatch(/[−-]\s*-/);
  });
});

describe("editing a reimbursed purchase into a credit", () => {
  function purchaseRow(over: Record<string, unknown> = {}) {
    return {
      id: PUR,
      opportunity_id: OPP,
      account_id: "acct",
      category: "materials",
      vendor: "Aboffs",
      vendor_id: null,
      amount_cents: 12_840,
      hours: null,
      purchased_at: "2026-10-01T16:00:00.000Z",
      description: null,
      receipt_document_id: null,
      reimburse_to: "Joe",
      reimbursed_at: null,
      ...over,
    };
  }
  beforeEach(() => {
    tables.commercial_opportunities = { maybeSingle: () => ({ id: OPP, account_id: "acct", deleted_at: null }) };
    tables.commercial_project_purchases = {
      maybeSingle: ({ op, payload }) => (op === "update" ? { ...purchaseRow(), ...(payload as object) } : purchaseRow()),
    };
  });

  it("is allowed when the same save clears the name", async () => {
    const { updatePurchase } = await import("@/lib/commercial/purchases/db");
    const res = await updatePurchase(PUR, { amount_cents: -12_840, reimburse_to: null }, "u1", OPP);
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    const written = updates.find((u) => u.table === "commercial_project_purchases")?.payload as Record<string, unknown>;
    expect(written.amount_cents).toBe(-12_840);
    expect(written.reimburse_to).toBeNull();
  });

  it("is still refused while the name stays", async () => {
    const { updatePurchase } = await import("@/lib/commercial/purchases/db");
    const kept = await updatePurchase(PUR, { amount_cents: -12_840, reimburse_to: "Joe" }, "u1", OPP);
    expect(kept.ok).toBe(false);
    const notSent = await updatePurchase(PUR, { amount_cents: -12_840 }, "u1", OPP);
    expect(notSent.ok, "a patch that does not mention the name keeps the saved one").toBe(false);
  });
});

describe("a renamed vendor keeps its purchases on an edit", () => {
  beforeEach(() => {
    // The directory now says the NEW name; the purchase still says the old.
    const vendor = { id: VEN, name: "Sherwin-Williams #4412", status: "active", kind: "retail" };
    tables.commercial_vendors = { maybeSingle: () => vendor, list: () => [vendor] };
  });

  it("keeps the link while the box still says what the row was saved with", async () => {
    const { resolvePurchaseVendor } = await import("@/lib/commercial/vendors/db");
    const v = await resolvePurchaseVendor({
      vendorId: VEN,
      vendorText: "Sherwin Williams",
      category: "materials",
      createIfNew: false,
      userId: "u1",
      savedVendorText: "Sherwin Williams",
    });
    expect(v.vendor_id).toBe(VEN);
    // The link is kept; the name the row was saved with is not rewritten.
    expect(v.vendor).toBe("Sherwin Williams");
  });

  it("drops it when the box was changed to someone else", async () => {
    const { resolvePurchaseVendor } = await import("@/lib/commercial/vendors/db");
    const v = await resolvePurchaseVendor({
      vendorId: VEN,
      vendorText: "Home Depot",
      category: "materials",
      createIfNew: false,
      userId: "u1",
      savedVendorText: "Sherwin Williams",
    });
    expect(v.vendor_id).toBeNull();
    expect(v.vendor).toBe("Home Depot");
  });

  it("drops it on an add, where there is no saved text to vouch for it", async () => {
    const { resolvePurchaseVendor } = await import("@/lib/commercial/vendors/db");
    const v = await resolvePurchaseVendor({
      vendorId: VEN,
      vendorText: "Sherwin Williams",
      category: "materials",
      createIfNew: false,
      userId: "u1",
    });
    expect(v.vendor_id).toBeNull();
  });
});

describe("Accounting's purchase form links the vendor directory", () => {
  function form(fields: Record<string, string>) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  }

  it("saves a typed directory vendor WITH its link and the directory's spelling", async () => {
    const vendor = { id: VEN, name: "Aboffs", status: "active", kind: "retail" };
    tables.commercial_vendors = { list: () => [vendor], maybeSingle: () => vendor };
    tables.commercial_opportunities = { maybeSingle: () => ({ id: OPP, account_id: "acct", deleted_at: null }) };
    let inserted: Record<string, unknown> | null = null;
    tables.commercial_project_purchases = {
      maybeSingle: ({ op, payload }) => {
        if (op === "insert") inserted = payload as Record<string, unknown>;
        return op === "insert" ? payload : null;
      },
    };
    const { recordSpend } = await import("@/lib/commercial/accounting/record-spend");
    const res = await recordSpend(
      form({ kind: "purchase", opportunity_id: OPP, vendor: "aboffs", amount: "128.40", purchased_at: "2026-10-16", category: "materials" }),
      "u1",
    );
    expect(res.ok).toBe(true);
    expect(inserted).not.toBeNull();
    expect(inserted!.vendor_id).toBe(VEN);
    expect(inserted!.vendor).toBe("Aboffs");
  });

  it("brings back everything she typed when the save is refused", async () => {
    const { recordSpend } = await import("@/lib/commercial/accounting/record-spend");
    const { spendPreserveFromParams } = await import("@/lib/commercial/accounting/spend-preserve");
    const typed = {
      kind: "purchase",
      opportunity_id: OPP,
      vendor: "Aboffs",
      amount: "0",
      purchased_at: "2026-10-16",
      category: "other",
      category_other: "dumpster hire",
      description: "INV 5521",
      reimburse_to: "Joe",
    };
    const res = await recordSpend(form(typed), "u1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // Through the URL and back, the way the page reads it.
    const url = new URLSearchParams({ view: res.view, error: res.error, ...res.preserve });
    const back = spendPreserveFromParams((k) => url.get(k) ?? undefined);
    expect(back).toEqual({
      sp_job: OPP,
      sp_vendor: "Aboffs",
      sp_amt: "0",
      sp_date: "2026-10-16",
      sp_cat: "other",
      sp_cat_other: "dumpster hire",
      sp_desc: "INV 5521",
      sp_reimb: "Joe",
    });
  });
});

describe("the Purchases CSV is grouped and filtered like the screen", () => {
  const spend = [
    { id: "1", oppId: null, accountId: null, jobName: "Job A", vendor: "Aboffs", category: "materials", categoryLabel: "Materials", ymd: "2026-10-02", amountCents: 1000, reference: null, hasReceipt: false, receiptDocumentId: null, reimburseTo: null, reimbursedYmd: null },
    { id: "2", oppId: null, accountId: null, jobName: "Job B", vendor: "Home Depot", category: "materials", categoryLabel: "Materials", ymd: "2026-10-03", amountCents: 2000, reference: null, hasReceipt: false, receiptDocumentId: null, reimburseTo: null, reimbursedYmd: null },
  ];

  beforeEach(() => {
    vi.resetModules();
    vi.doMock("@/lib/commercial/reports/export-guard", async (orig) => ({
      ...(await orig<typeof import("@/lib/commercial/reports/export-guard")>()),
      guardExport: async () => ({ ok: true }),
    }));
    vi.doMock("@/lib/commercial/reports/tomco/transactions", async (orig) => ({
      ...(await orig<typeof import("@/lib/commercial/reports/tomco/transactions")>()),
      getSpendRows: async () => spend,
    }));
  });

  async function csv(qs: string): Promise<string> {
    const { GET } = await import("@/app/api/commercial/accounting/export/route");
    const { NextRequest } = await import("next/server");
    const res = await GET(new NextRequest(`http://x/api/commercial/accounting/export?${qs}`));
    return await res.text();
  }

  it("carries the vendor: one vendor's statement holds only that vendor", async () => {
    const out = await csv("view=purchases&pvendor=Aboffs");
    expect(out).toContain("Aboffs");
    expect(out).not.toContain("Home Depot");
    expect(out).toContain(`"Total records","1"`);
  });

  it("carries the group-by: Job groups rows under the job", async () => {
    const out = await csv("view=purchases&pgroup=1");
    const groupCells = out
      .split("\n")
      .filter((l) => /^"?Job [AB]/.test(l))
      .map((l) => l.split(",")[0].replace(/"/g, ""));
    expect(groupCells).toContain("Job A");
    expect(groupCells).toContain("Job B");
  });
});
