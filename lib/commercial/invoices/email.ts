import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { getCommercialInvoice } from "./db";
import { changeInvoiceStatus } from "./status";
import { listInvoiceAttachments } from "./attachments";
import { buildInvoicePdfInput } from "./invoice-pdf-data";
import { getDocument, STORAGE_BUCKET } from "@/lib/commercial/documents/db";
import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { sanitizeFileName } from "@/lib/commercial/accounts/documents";
import { withArchiveBcc } from "@/lib/commercial/email-archive/auto-bcc";

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
/**
 * Katie, 2026-09-17: "Invoices sent from finance@ ; cc: mary@tomcopainting.com.
 * Proposals sent from estimating@tomcopainting.com ; cc: Brendan."
 *
 * So the two documents stopped sharing a copy list — money to Mary, pricing to
 * Brendan.
 *
 * Karan, 2026-09-21, after Brendan sent an invoice and got nothing: Brendan
 * gets invoices too. He runs the jobs these bill for, and the first anyone knew
 * that he was not on the list was a customer-facing send. He is ADDED, not
 * swapped in — Mary is finance and still needs every invoice.
 *
 * These addresses become the Reply-To and a silent BCC. BCC is the reason this
 * went unnoticed: Mary was receiving them all along and no one else could see
 * that, so the send sheet now names this list on screen instead of describing
 * it from memory.
 */
export const INVOICE_COPY_EMAILS = (
  process.env.COMMERCIAL_INVOICE_COPY_EMAILS ||
  "mary@tomcopainting.com,brendan@tomcopainting.com,developer@precisionpaintingplus.net"
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

/**
 * The invoice PDF a GC actually receives — ONE page, like every customer
 * document on this platform.
 *
 * This existed inline, and rendered WITHOUT the fit ladder that the download
 * route has used since 2026-08-26. So the copy the team previewed was one page
 * and the copy that landed in the GC's inbox was two: the contract summary is a
 * keep-together block, so it moved wholesale onto a second sheet rather than
 * splitting. Exported, and asserted on page count in scripts/pdf-paths.live.test.ts,
 * because the bug is invisible in the source — both paths call the same renderer.
 */
export async function buildInvoiceEmailPdf(invoiceId: string): Promise<Buffer | null> {
  const pdfInput = await buildInvoicePdfInput(invoiceId);
  if (!pdfInput) return null;
  const { renderInvoicePdf } = await import("./invoice-pdf");
  const { renderFitToOnePage } = await import("@/lib/commercial/proposals/fit-one-page");
  const fit = await renderFitToOnePage((pageHeightScale) =>
    renderInvoicePdf({ ...pdfInput, pageHeightScale })
  );
  if (!fit.fitted) {
    console.warn(`[invoice-email] invoice ${invoiceId} is too long to fit one readable page — sent at its natural length`);
  }
  return fit.bytes;
}

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
  let pdf: Buffer;
  try {
    const built = await buildInvoiceEmailPdf(input.invoice_id);
    if (!built) return { ok: false, error: "Couldn't assemble the invoice — its deal may have been removed." };
    pdf = built;
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
  /**
   * WHO IT COMES FROM — finance@, per Katie.
   *
   * That caveat — "Resend will only send from a domain verified in the PPP
   * account, today precisionpaintingplus.net and NOT tomcopainting.com" —
   * expired on 2026-09-17 when tomcopainting.com was verified. So finance@ is
   * the default in code rather than a Vercel setting somebody has to remember.
   *
   * This one already resolved correctly by accident: with the env var unset it
   * fell through to the channel default, which is finance@tomcopainting.com.
   * Stating it here anyway, because "right because of a fallback two files
   * away" is not the same as right, and the day that default changes for
   * field-ops mail this would follow it silently.
   */
  const fromAddr =
    process.env.COMMERCIAL_INVOICE_FROM_ADDRESS || "finance@tomcopainting.com";
  const from = fromAddr ? `${oc.name} <${fromAddr}>` : undefined;
  const replyTo = INVOICE_COPY_EMAILS.length > 0 ? INVOICE_COPY_EMAILS : oc.email || undefined;
  const bcc = withArchiveBcc(
    INVOICE_COPY_EMAILS.filter((e) => e !== toEmail && e !== ccEmail),
    { opportunityId: invoice.opportunity_id, accountId: invoice.account_id },
    [toEmail, ccEmail]
  );

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

  // RECORD THE SEND. Always — not only from draft.
  //
  // A draft becomes SENT on delivery (stamps issued_at/sent_at + status log).
  // But an invoice created straight from a deal is ALREADY `sent`, so this
  // branch never ran for it and `sent_at` was never stamped by the thing that
  // actually sends. Combined with create stamping it optimistically, the
  // column recorded when the invoice was written rather than when it was
  // delivered — and once create stopped stamping it, an issued invoice that
  // really was emailed would have shown nothing at all.
  //
  // Best-effort throughout: the email has already gone, so a bookkeeping
  // hiccup must never be reported as a failed send.
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
  } else {
    // Already live (issued on create, viewed, or part-paid). Don't touch the
    // status — a re-send must not drag a partial back to `sent` — just record
    // that an email went out, and backfill issued_at if it was never set.
    const nowIso = new Date().toISOString();
    const { error: stampErr } = await commercialDb()
      .from("commercial_invoices")
      .update({
        sent_at: nowIso,
        ...(invoice.issued_at ? {} : { issued_at: nowIso }),
      })
      .eq("id", input.invoice_id);
    if (stampErr) {
      console.warn(`[emailInvoiceToGc] sent email but could not stamp sent_at for ${input.invoice_id}: ${stampErr.message}`);
    }
    const { logStatusChange } = await import("./db");
    await logStatusChange(
      input.invoice_id,
      invoice.status,
      invoice.status,
      input.actor_user_id,
      `Emailed to ${toEmail}`,
    ).catch((err: unknown) => console.warn("[emailInvoiceToGc] status log failed:", err));
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
