import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * What the invoice email can actually carry.
 *
 * Katie's list: *"Final bill sent WITH a final lien waiver."* It could not be.
 * The signed waiver is stored on `commercial_invoices.lien_waiver_document_id`
 * and the send path read `commercial_invoice_attachments` — two stores that
 * never met — so the one document she named by name was the one document the
 * email could never include, whatever the sender ticked. The invoice page even
 * described its attachment list as "typically signed lien waivers".
 *
 * This is a SEAM test. Both halves were individually correct: the waiver was
 * stored, the attachments were sent. The defect lived between them, which is
 * where every bug of this shape in this codebase has lived.
 *
 * Mocked at the DATA boundary — the attachments table and the waiver reader —
 * so the union logic under test is the real one. Spying on a sibling export
 * does not work here: the call is intra-module and never goes through the
 * exports object, which is how the first version of this file "passed" while
 * exercising nothing.
 */

const attachmentRows = vi.fn();
const docsByIds = vi.fn();
const getWaiver = vi.fn();

vi.mock("@/lib/commercial/db", () => ({
  commercialDb: () => ({
    from: () => ({ select: () => ({ eq: () => attachmentRows() }) }),
  }),
}));
vi.mock("@/lib/commercial/documents/db", () => ({
  getDocumentsByIds: (...a: unknown[]) => docsByIds(...a),
}));
vi.mock("@/lib/commercial/invoices/lien-waiver", () => ({
  getInvoiceLienWaiver: (...a: unknown[]) => getWaiver(...a),
}));

const doc = (id: string, name: string, uploaded = "2026-09-01T00:00:00Z") =>
  ({ id, file_name: name, uploaded_at: uploaded }) as never;

/** Wire the attachments table to return these documents, in this order. */
function attachmentsAre(docs: { id: string }[]) {
  attachmentRows.mockResolvedValue({
    data: docs.map((d) => ({ document_id: d.id })),
    error: null,
  });
  docsByIds.mockResolvedValue(new Map(docs.map((d) => [d.id, d])));
}

async function subject() {
  return (await import("@/lib/commercial/invoices/attachments")).listInvoiceSendableDocuments;
}

describe("the files that go out with an invoice", () => {
  beforeEach(() => {
    attachmentRows.mockReset();
    docsByIds.mockReset();
    getWaiver.mockReset();
  });

  it("includes the signed lien waiver, which used to be unreachable", async () => {
    attachmentsAre([doc("a1", "photos.pdf")]);
    getWaiver.mockResolvedValue(doc("w1", "final-waiver-signed.pdf"));
    const out = await (await subject())("inv1");
    expect(out.map((d) => d.id)).toContain("w1");
  });

  it("puts the waiver FIRST — it is the one the GC is waiting for", async () => {
    attachmentsAre([doc("a1", "photos.pdf")]);
    getWaiver.mockResolvedValue(doc("w1", "final-waiver-signed.pdf"));
    expect((await (await subject())("inv1")).map((d) => d.id)).toEqual(["w1", "a1"]);
  });

  it("lists a waiver that is ALSO an attachment exactly once", async () => {
    // Otherwise the same PDF is attached twice and counted twice against the
    // size cap, which can silently drop a different file.
    attachmentsAre([doc("w1", "final-waiver-signed.pdf")]);
    getWaiver.mockResolvedValue(doc("w1", "final-waiver-signed.pdf"));
    expect((await (await subject())("inv1")).map((d) => d.id)).toEqual(["w1"]);
  });

  it("returns just the attachments when there is no waiver yet", async () => {
    attachmentsAre([doc("a1", "photos.pdf")]);
    getWaiver.mockResolvedValue(null);
    expect((await (await subject())("inv1")).map((d) => d.id)).toEqual(["a1"]);
  });

  it("still sends the attachments when the waiver lookup fails", async () => {
    // A missing waiver must not cost the GC the rest of the paperwork.
    attachmentsAre([doc("a1", "photos.pdf")]);
    getWaiver.mockRejectedValue(new Error("table missing"));
    expect((await (await subject())("inv1")).map((d) => d.id)).toEqual(["a1"]);
  });

  it("sends the waiver even when there are no other attachments", async () => {
    // The commonest final-bill shape, and the one the old code got wrong most
    // visibly: nothing attached at all, so the checkbox never even appeared.
    attachmentsAre([]);
    getWaiver.mockResolvedValue(doc("w1", "final-waiver-signed.pdf"));
    expect((await (await subject())("inv1")).map((d) => d.id)).toEqual(["w1"]);
  });
});
