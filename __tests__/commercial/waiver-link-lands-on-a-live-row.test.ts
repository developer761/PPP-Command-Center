import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A lien waiver (or a signed contract) is only "on file" if the row it was
 * linked to is LIVE and the write actually landed on it.
 *
 * Every one of these writes was `update(...).eq("id", x)` with only `error`
 * checked. Against a row deleted in another tab between the scope read and
 * the write, PostgREST returns success with zero rows changed — so the user
 * was told the waiver saved while it was attached to nothing. And on the
 * payment target of the large-file path the opposite: it filtered a
 * `deleted_at` column that `commercial_invoice_payments` does not have, which
 * is a 42703 error, so every payment waiver filed that way was refused as
 * "That record no longer exists."
 *
 * The fake below behaves like PostgREST where it matters: a filter or select
 * on a column the table does not have is an error, not an empty result, and an
 * update matching nothing returns no row. The column lists come from the
 * migrations — the artifact — and are cross-checked against them below.
 */

type Row = Record<string, unknown>;
const COLUMNS: Record<string, string[]> = {
  commercial_invoices: ["id", "opportunity_id", "invoice_number", "status", "lien_waiver_document_id", "deleted_at"],
  commercial_aia_applications: ["id", "opportunity_id", "application_number", "lien_waiver_document_id", "deleted_at"],
  commercial_invoice_payments: ["id", "invoice_id", "reference", "paid_at", "lien_waiver_document_id"],
  commercial_documents: ["id", "parent_type", "parent_id", "category", "deleted_at"],
  commercial_signature_requests: ["id", "signed_document_id", "signed_sha256", "audit_document_id"],
};
let tables: Record<string, Row[]> = {};
/** Runs after a table's first read — "deleted in another tab" in between. */
let afterFirstRead: ((table: string) => void) | null = null;

function query(table: string) {
  let op: "select" | "update" = "select";
  let patch: Row = {};
  const filters: [string, unknown][] = [];
  const named: string[] = [];
  const b = {
    select(cols: string) {
      named.push(...cols.split(",").map((c) => c.trim()).filter((c) => /^[a-z_]+$/.test(c)));
      return b;
    },
    update(p: Row) {
      op = "update";
      patch = p;
      named.push(...Object.keys(p));
      return b;
    },
    eq(c: string, v: unknown) { filters.push([c, v]); named.push(c); return b; },
    is(c: string, v: unknown) { filters.push([c, v]); named.push(c); return b; },
    order() { return b; },
    maybeSingle() {
      return run(true);
    },
    // Awaiting the builder itself runs it too — an update with no .select()
    // is a real write that returns no rows, exactly as PostgREST does.
    then(ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) {
      return run(false).then(ok, bad);
    },
  };
  async function run(single: boolean) {
    const missing = named.find((c) => !COLUMNS[table]?.includes(c));
    if (missing) return { data: null, error: { code: "42703", message: `column ${table}.${missing} does not exist` } };
    const rows = (tables[table] ?? []).filter((r) => filters.every(([c, v]) => (r[c] ?? null) === v));
    if (op === "update") {
      for (const r of rows) Object.assign(r, patch);
    } else {
      const hook = afterFirstRead;
      if (hook) { afterFirstRead = null; hook(table); }
    }
    const out = rows.map((r) => ({ ...r }));
    return { data: single ? (out[0] ?? null) : out, error: null };
  }
  return b;
}

vi.mock("@/lib/commercial/db", () => ({ commercialDb: () => ({ from: (t: string) => query(t) }) }));
const softDeleted: string[] = [];
const audit: unknown[] = [];
vi.mock("@/lib/commercial/documents/db", () => ({
  STORAGE_BUCKET: "x",
  uploadDocument: async () => ({ ok: true, document: { id: "doc-new" } }),
  getDocument: async () => null,
  getDocumentsByIds: async () => new Map(),
  softDeleteDocument: async (id: string) => { softDeleted.push(id); return { ok: true }; },
}));
vi.mock("@/lib/commercial/audit-log", () => ({ logUpdate: async (...a: unknown[]) => { audit.push(a); } }));

const file = { file_name: "w.pdf", mime_type: "application/pdf", data: new Uint8Array([1]), actorUserId: "u1" };
const DEL = "2026-10-16T00:00:00Z";

beforeEach(() => {
  softDeleted.length = 0;
  audit.length = 0;
  afterFirstRead = null;
  tables = {
    commercial_invoices: [{ id: "inv1", opportunity_id: "opp1", invoice_number: "INV-1", status: "sent", lien_waiver_document_id: "doc-old", deleted_at: null }],
    commercial_aia_applications: [{ id: "app1", opportunity_id: "opp1", application_number: 1, lien_waiver_document_id: "doc-old", deleted_at: null }],
    commercial_invoice_payments: [{ id: "pay1", invoice_id: "inv1", reference: "1001", paid_at: "2026-10-01", lien_waiver_document_id: null }],
    commercial_documents: [{ id: "doc-up", parent_type: "opportunity", parent_id: "opp1", category: "lien_waiver", deleted_at: null }],
    commercial_signature_requests: [{ id: "req1", signed_document_id: null, signed_sha256: null, audit_document_id: null }],
  };
});

const deleteRow = (table: string, id: string) => () => {
  const r = tables[table].find((x) => x.id === id);
  if (r) r.deleted_at = DEL;
};

describe("the fake's columns are the migrations' columns", () => {
  const sql = readdirSync(join(process.cwd(), "supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(process.cwd(), "supabase/migrations", f), "utf8").replace(/--[^\n]*/g, ""))
    .join("\n");
  /** Does any migration give `table` this column — in its CREATE TABLE or an ADD COLUMN? */
  const has = (table: string, col: string) => {
    const create = new RegExp(`create table (?:if not exists )?(?:public\\.)?${table}\\s*\\(([\\s\\S]*?)\\n\\);`, "i").exec(sql);
    if (create && new RegExp(`^\\s*${col}\\s`, "im").test(create[1])) return true;
    return new RegExp(`alter table (?:if exists )?(?:public\\.)?${table}[\\s\\S]{0,400}?add column (?:if not exists )?${col}\\b`, "i").test(sql);
  };
  it("payments have NO deleted_at; the others do", () => {
    expect(has("commercial_invoice_payments", "lien_waiver_document_id")).toBe(true);
    expect(has("commercial_invoice_payments", "deleted_at")).toBe(false);
    expect(has("commercial_invoices", "deleted_at")).toBe(true);
    expect(has("commercial_aia_applications", "deleted_at")).toBe(true);
  });
});

describe("filing an already-uploaded waiver (large-file path)", () => {
  async function link(target: "invoice" | "payment" | "aia", id: string) {
    const { linkLienWaiverDocument } = await import("@/lib/commercial/invoices/lien-waiver-link");
    return linkLienWaiverDocument({ target, id, documentId: "doc-up", actorUserId: "u1" });
  }

  it("files a PAYMENT waiver — it used to 42703 on a column payments don't have", async () => {
    expect(await link("payment", "pay1")).toEqual({ ok: true });
    expect(tables.commercial_invoice_payments[0].lien_waiver_document_id).toBe("doc-up");
  });

  it("refuses an invoice deleted between the scope read and the write, and leaves no trace", async () => {
    afterFirstRead = deleteRow("commercial_invoices", "inv1");
    const r = await link("invoice", "inv1");
    expect(r.ok).toBe(false);
    expect(audit).toHaveLength(0); // no audit row for a write that didn't land
    expect(softDeleted).not.toContain("doc-old"); // the previous waiver is not retired
  });
});

describe("uploading a waiver against a row deleted mid-flight", () => {
  it("invoice: refuses, and retires the stranded upload", async () => {
    const { attachInvoiceLienWaiver } = await import("@/lib/commercial/invoices/lien-waiver");
    afterFirstRead = deleteRow("commercial_invoices", "inv1");
    const r = await attachInvoiceLienWaiver({ invoiceId: "inv1", ...file });
    expect(r.ok).toBe(false);
    expect(softDeleted).toEqual(["doc-new"]);
  });

  it("AIA application: refuses, and retires the stranded upload", async () => {
    const { attachAiaLienWaiver } = await import("@/lib/commercial/aia/lien-waiver");
    afterFirstRead = deleteRow("commercial_aia_applications", "app1");
    const r = await attachAiaLienWaiver({ applicationId: "app1", ...file });
    expect(r.ok).toBe(false);
    expect(softDeleted).toEqual(["doc-new"]);
  });

  it("payment on a deleted invoice: refused before anything is uploaded", async () => {
    const { attachPaymentLienWaiver } = await import("@/lib/commercial/invoices/payment-lien-waiver");
    tables.commercial_invoices[0].deleted_at = DEL;
    const r = await attachPaymentLienWaiver({ paymentId: "pay1", ...file });
    expect(r.ok).toBe(false);
    expect(tables.commercial_invoice_payments[0].lien_waiver_document_id).toBeNull();
  });

  it("payment removed mid-flight: refuses, and retires the stranded upload", async () => {
    const { attachPaymentLienWaiver } = await import("@/lib/commercial/invoices/payment-lien-waiver");
    afterFirstRead = (t) => { if (t === "commercial_invoice_payments") tables.commercial_invoice_payments = []; };
    const r = await attachPaymentLienWaiver({ paymentId: "pay1", ...file });
    expect(r.ok).toBe(false);
    expect(softDeleted).toEqual(["doc-new"]);
  });

  it("a live invoice still takes its waiver and retires the old one", async () => {
    const { attachInvoiceLienWaiver } = await import("@/lib/commercial/invoices/lien-waiver");
    const r = await attachInvoiceLienWaiver({ invoiceId: "inv1", ...file });
    expect(r.ok).toBe(true);
    expect(tables.commercial_invoices[0].lien_waiver_document_id).toBe("doc-new");
    expect(softDeleted).toEqual(["doc-old"]);
  });
});

describe("linking the signed contract to its signature request", () => {
  it("says whether the link landed", async () => {
    const { setSignatureDocuments } = await import("@/lib/commercial/esign/db");
    expect(await setSignatureDocuments("req1", { signed_document_id: "d1", signed_sha256: "h" })).toBe(true);
    expect(tables.commercial_signature_requests[0].signed_document_id).toBe("d1");
    expect(await setSignatureDocuments("gone", { audit_document_id: "d2" })).toBe(false);
  });
});
