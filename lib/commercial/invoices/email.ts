import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { getCommercialInvoice } from "./db";
import { changeInvoiceStatus } from "./status";
import { listInvoiceAttachments } from "./attachments";
import { buildInvoicePdfInput } from "./invoice-pdf-data";
import { getDocument, STORAGE_BUCKET } from "@/lib/commercial/documents/db";
import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { sanitizeFileName } from "@/lib/commercial/accounts/documents";

/**
 * Email a branded invoice PDF to the general contractor via Resend (Katie's #1 —
 * invoices were on-screen only). Mirrors emailProposalToGc: human-reviewed
 * (recipient / subject / message come from the review sheet, nothing auto-sends),
 * the internal copies (Brendan + ops) become the Reply-To AND a silent BCC, and
 * the same PDF the team previewed is attached.
 *
 * Sending a DRAFT marks it sent (stamps issued_at/sent_at + status log). A void
 * invoice can't be emailed. Re-sending a live invoice just re-delivers it.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Internal copies on every invoice sent to a GC (same list as proposals —
 *  Brendan runs approvals + the ops inbox keeps a copy). Env-overridable. */
const INVOICE_COPY_EMAILS = (
  process.env.COMMERCIAL_INVOICE_COPY_EMAILS ||
  process.env.COMMERCIAL_PROPOSAL_COPY_EMAILS ||
  "brendan@tomcopainting.com,developer@precisionpaintingplus.net"
)
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter((e) => EMAIL_RE.test(e));

// Resend caps a message near 40 MB; keep a safety margin for the base64 inflation
// (~33%) + the invoice PDF itself. Extra attachments beyond this are skipped with
// a heads-up rather than bouncing the whole send.
const MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024;

export type EmailInvoiceInput = {
  invoice_id: string;
  actor_user_id: string;
  to_email: string;
  cc_email?: string | null;
  subject: string;
  message: string;
  /** Katie: attach the files already on this invoice (signed lien waivers, etc.). */
  include_attachments?: boolean;
};

export type EmailInvoiceResult =
  | { ok: true; to_email: string; warning?: string }
  | { ok: false; error: string };

export async function emailInvoiceToGc(input: EmailInvoiceInput): Promise<EmailInvoiceResult> {
  const toEmail = (input.to_email ?? "").trim().toLowerCase();
  const ccEmail = (input.cc_email ?? "").trim().toLowerCase() || null;
  const subject = (input.subject ?? "").trim();
  const message = (input.message ?? "").trim();

  if (!EMAIL_RE.test(toEmail)) return { ok: false, error: "Enter a valid recipient email." };
  if (ccEmail && !EMAIL_RE.test(ccEmail)) return { ok: false, error: "The CC email isn't valid." };
  if (!subject) return { ok: false, error: "Add a subject." };
  if (!message) return { ok: false, error: "Add a message." };

  const invoice = await getCommercialInvoice(input.invoice_id);
  if (!invoice) return { ok: false, error: "Invoice not found." };
  if (invoice.status === "void") {
    return { ok: false, error: "This invoice is void — reopen it as a draft before sending." };
  }

  // Render the exact bytes the team previewed.
  const pdfInput = await buildInvoicePdfInput(input.invoice_id);
  if (!pdfInput) return { ok: false, error: "Couldn't assemble the invoice — its deal may have been removed." };
  let pdf: Buffer;
  try {
    const { renderInvoicePdf } = await import("./invoice-pdf");
    pdf = await renderInvoicePdf(pdfInput);
  } catch (err) {
    console.error("[emailInvoiceToGc] pdf render failed:", err);
    return { ok: false, error: "The invoice PDF couldn't be generated — try again." };
  }

  const filename = `${sanitizeFileName(`Invoice_${invoice.invoice_number}`)}.pdf`;
  const attachments: Array<{ filename: string; content: Buffer }> = [{ filename, content: pdf }];
  let warning: string | undefined;

  // Optionally attach the invoice's own files (Katie). Cap the total so a big
  // set can't bounce the send — anything over budget is dropped with a note.
  if (input.include_attachments) {
    const sb = commercialDb();
    const docs = await listInvoiceAttachments(input.invoice_id).catch(() => []);
    let total = pdf.byteLength;
    let skipped = 0;
    for (const d of docs) {
      const doc = await getDocument(d.id).catch(() => null);
      if (!doc) { skipped++; continue; }
      const { data: blob, error } = await sb.storage.from(STORAGE_BUCKET).download(doc.storage_key);
      if (error || !blob) { skipped++; continue; }
      const bytes = Buffer.from(await blob.arrayBuffer());
      if (total + bytes.byteLength > MAX_ATTACHMENT_BYTES) { skipped++; continue; }
      total += bytes.byteLength;
      attachments.push({ filename: sanitizeFileName(doc.file_name) || "attachment", content: bytes });
    }
    if (skipped > 0) {
      warning = `${skipped} attached file${skipped === 1 ? "" : "s"} couldn't be included (too large or unavailable) — the invoice PDF still went out.`;
    }
  }

  // From = operating-company name over the commercial sending address; replies +
  // silent BCC go to Brendan + ops (skip an address that's already visible).
  const oc = await getOperatingCompany();
  const fromAddr = process.env.COMMERCIAL_RESEND_FROM_ADDRESS || process.env.RESEND_FROM_ADDRESS;
  const from = fromAddr ? `${oc.name} <${fromAddr}>` : undefined;
  const replyTo = INVOICE_COPY_EMAILS.length > 0 ? INVOICE_COPY_EMAILS : oc.email || undefined;
  const bcc = INVOICE_COPY_EMAILS.filter((e) => e !== toEmail && e !== ccEmail);

  const { sendEmail } = await import("@/lib/email/resend");
  const r = await sendEmail({
    channel: "commercial",
    to: toEmail,
    ...(ccEmail ? { cc: ccEmail } : {}),
    subject,
    text: message,
    ...(from ? { from } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(bcc.length > 0 ? { bcc } : {}),
    attachments,
    tags: [
      { name: "kind", value: "invoice_to_gc" },
      { name: "invoice", value: input.invoice_id },
    ],
  });
  if (!r.ok) {
    return { ok: false, error: `The invoice didn't go out: ${r.error}` };
  }

  // A draft becomes SENT on delivery (stamps issued_at/sent_at + status log).
  // Best-effort — the email already went, so a status hiccup doesn't fail it.
  if (invoice.status === "draft") {
    const flip = await changeInvoiceStatus({
      invoice_id: input.invoice_id,
      to_status: "sent",
      acting_user_id: input.actor_user_id,
      note: `Emailed to ${toEmail}`,
    });
    if (!flip.ok) {
      console.warn(`[emailInvoiceToGc] sent email but status flip failed for ${input.invoice_id}: ${flip.error}`);
    }
  }

  // Timeline note (system-posted, links back to the deal).
  try {
    const { addAccountNote } = await import("@/lib/commercial/account-notes");
    await addAccountNote({
      account_id: invoice.account_id,
      body: `Invoice ${invoice.invoice_number} emailed to ${toEmail}.`,
      kind: "auto_debrief",
      source_opportunity_id: invoice.opportunity_id,
      author_user_id: input.actor_user_id,
    });
  } catch (err) {
    console.warn("[emailInvoiceToGc] account note failed:", err);
  }

  return { ok: true, to_email: toEmail, warning };
}
