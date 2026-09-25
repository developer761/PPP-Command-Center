import { proposalLabel } from "@/lib/commercial/proposals/constants";
import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { getProposal, sendProposal, type CommercialProposal } from "./db";
import { getDocument, STORAGE_BUCKET } from "@/lib/commercial/documents/db";
import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { sanitizeFileName } from "@/lib/commercial/accounts/documents";
import { PROPOSAL_COPY_EMAILS } from "./copy-emails";
import { withArchiveBcc } from "@/lib/commercial/email-archive/auto-bcc";

/**
 * Kim — email an approved proposal PDF to the general contractor via Resend.
 *
 * This is the delivery half of the R1 approval flow: `sendProposal` already
 * renders + files the PDF and marks the proposal "sent"; this actually puts it
 * in the GC's inbox. Human-reviewed (subject/message/recipient come from the
 * review sheet — nothing auto-sends).
 *
 * Behaviour by status:
 *   - approved  → runs `sendProposal` first (render + file snapshot + mark sent
 *                 + team bell + "sent" note), then emails that exact snapshot.
 *   - sent      → re-send: emails the existing snapshot, no status re-flip.
 *   - anything else → refused (R1 hard gate).
 *
 * The attachment is the FILED snapshot (the approved bytes), never a live
 * re-render, so what the GC receives can't drift from what was approved.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type EmailProposalInput = {
  proposal_id: string;
  actor_user_id: string;
  actor_name?: string;
  actor_email?: string | null;
  to_email: string;
  to_name?: string | null;
  cc_email?: string | null;
  subject: string;
  message: string;
  /** Include a "Review & sign" link (Karan 2026-09-15). The PDF is attached
   *  either way — a GC who prints and signs by hand still can. */
  request_signature?: boolean;
};

export type EmailProposalResult =
  | {
      ok: true;
      send: { id: string; to_email: string; created_at: string };
      /** What happened to the signing link, for the send sheet to say so. */
      signature: { included: boolean; note: string | null };
    }
  | { ok: false; error: string };

export async function emailProposalToGc(input: EmailProposalInput): Promise<EmailProposalResult> {
  const toEmail = (input.to_email ?? "").trim().toLowerCase();
  const ccEmail = (input.cc_email ?? "").trim().toLowerCase() || null;
  const subject = (input.subject ?? "").trim();
  const message = (input.message ?? "").trim();

  if (!EMAIL_RE.test(toEmail)) return { ok: false, error: "Enter a valid recipient email." };
  if (ccEmail && !EMAIL_RE.test(ccEmail)) return { ok: false, error: "The CC email isn't valid." };
  if (!subject) return { ok: false, error: "Add a subject." };
  if (!message) return { ok: false, error: "Add a message." };

  const sb = commercialDb();
  let proposal = await getProposal(input.proposal_id);
  if (!proposal) return { ok: false, error: "Proposal not found." };

  // R1 hard gate — only an approved (first send) or already-sent (re-send)
  // proposal can be delivered.
  if (proposal.status !== "approved" && proposal.status !== "sent") {
    return {
      ok: false,
      error:
        proposal.status === "pending_approval"
          ? "This proposal is awaiting approval — it must be approved before it can be emailed."
          : proposal.status === "draft"
          ? "Send for approval first — a proposal must be approved before it goes to the GC."
          : `A ${proposal.status} proposal can't be emailed.`,
    };
  }

  // Parent opp → account_id + gc label.
  const { data: oppRow } = await sb
    .from("commercial_opportunities")
    .select("id, account_id, deleted_at")
    .eq("id", proposal.opportunity_id)
    .is("deleted_at", null)
    .maybeSingle();
  const opp = oppRow as { id: string; account_id: string } | null;
  if (!opp) return { ok: false, error: "This proposal's deal no longer exists." };

  // Ensure a filed snapshot PDF. Approved → run the real send (which files it);
  // sent → reuse the existing snapshot.
  let snapshotId = proposal.snapshot_document_id;
  if (proposal.status === "approved") {
    const sent = await sendProposal({
      proposal_id: input.proposal_id,
      actor_user_id: input.actor_user_id,
      actor_name: input.actor_name,
    });
    if (!sent.ok) return { ok: false, error: sent.error };
    snapshotId = sent.snapshot_document_id;
    proposal = sent.proposal as CommercialProposal;
  }
  if (!snapshotId) {
    return { ok: false, error: "No PDF is on file for this proposal — unlock and re-approve to regenerate it." };
  }

  // Download the snapshot bytes (the exact approved copy).
  const doc = await getDocument(snapshotId);
  if (!doc) return { ok: false, error: "Marked sent, but the PDF couldn't be found to attach — try again." };
  const { data: blob, error: dlErr } = await sb.storage.from(STORAGE_BUCKET).download(doc.storage_key);
  if (dlErr || !blob) {
    return { ok: false, error: "Marked sent, but the PDF couldn't be read to attach — try again." };
  }
  const pdf = Buffer.from(await blob.arrayBuffer());

  // From = operating company display-name over the commercial sending address;
  // reply-to = the company's inbox (or the sender) so the GC reaches a person.
  const oc = await getOperatingCompany();
  /**
   * WHO IT COMES FROM — estimating@, per Katie (2026-09-17). That is Kim
   * Laude's inbox, and a proposal should come from the person who priced it.
   *
   * The caveat this carried — "Resend will only send from a domain verified in
   * the PPP account, which today is precisionpaintingplus.net and NOT
   * tomcopainting.com" — expired on 2026-09-17 when tomcopainting.com was
   * verified. Until now the env var was unset, so proposals quietly fell
   * through to the channel default and went out from finance@: the invoicing
   * inbox, on a document Kim wrote.
   *
   * So estimating@ is the default in CODE now, the same move resend.ts made
   * for the channel. An env var that has to be set in Vercel for the right
   * thing to happen is a setting that is wrong by default, and this one was
   * wrong for six days without anyone seeing it — the address only shows on
   * the GC's copy.
   */
  const fromAddr =
    process.env.COMMERCIAL_PROPOSAL_FROM_ADDRESS || "estimating@tomcopainting.com";
  const from = fromAddr ? `${oc.name} <${fromAddr}>` : undefined;
  // Replies from the GC go to Brendan (approver) + the ops inbox; fall back to
  // the company/actor address only if the copy list is somehow empty.
  const replyTo =
    PROPOSAL_COPY_EMAILS.length > 0
      ? PROPOSAL_COPY_EMAILS
      : oc.email || input.actor_email || undefined;
  // Don't BCC an address that's already the visible recipient/CC.
  const bcc = withArchiveBcc(
    PROPOSAL_COPY_EMAILS.filter((e) => e !== toEmail && e !== ccEmail),
    { opportunityId: proposal.opportunity_id, accountId: opp?.account_id },
    [toEmail, ccEmail]
  );

  const projectLabel =
    proposal.header_json.project_name?.trim() || proposal.header_json.gc_company?.trim() || "Proposal";
  // Brendan 2026-08-17: "Can we remove the R1 on the attachment name". The
  // revision is labelled inside the document, on the PROJECT line — the GC
  // shouldn't have to read our internal revision counter off a filename.
  const filename = `${sanitizeFileName(`Proposal_${projectLabel}`)}.pdf`;

  // E-signature link. Issued AFTER the snapshot exists (sendProposal above), so
  // the hash it records is of the exact bytes attached to this email. A
  // proposal that is already signed goes out without a link — asking for a
  // second signature on a signed contract helps nobody.
  let signatureRequestId: string | null = null;
  let signatureNote: string | null = null;
  let text = message;
  let html: string | undefined;
  if (input.request_signature) {
    const { createSignatureRequest } = await import("@/lib/commercial/esign/db");
    const { signingUrl } = await import("@/lib/commercial/esign/workflow");
    const req = await createSignatureRequest({
      proposalId: input.proposal_id,
      signerEmail: toEmail,
      signerName: input.to_name ?? proposal.header_json.attention ?? null,
      requestedBy: { userId: input.actor_user_id, name: input.actor_name ?? null, email: input.actor_email ?? null },
    });
    if (req.ok) {
      signatureRequestId = req.request.id;
      const url = signingUrl(req.token);
      text = `${message}\n\nReview and sign the proposal online:\n${url}\n\nThe link is personal to you and stays open for 30 days.`;
      html = signingEmailHtml(message, url, oc.name);
    } else {
      signatureNote =
        req.reason === "already_signed"
          ? "Sent without a signing link — this proposal is already signed."
          : `Sent without a signing link: ${req.error}`;
      console.warn(`[emailProposalToGc] signing link not issued for ${input.proposal_id}: ${req.error}`);
    }
  }

  const { sendEmail } = await import("@/lib/email/resend");
  const r = await sendEmail({
    channel: "commercial",
    to: toEmail,
    ...(ccEmail ? { cc: ccEmail } : {}),
    subject,
    text,
    ...(html ? { html } : {}),
    ...(from ? { from } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(bcc.length > 0 ? { bcc } : {}),
    attachments: [{ filename, content: pdf }],
    tags: [
      { name: "kind", value: "proposal_to_gc" },
      { name: "proposal", value: input.proposal_id },
    ],
  });
  if (!r.ok) {
    if (signatureRequestId) {
      const { voidUnsentRequest } = await import("@/lib/commercial/esign/db");
      await voidUnsentRequest(signatureRequestId, `The email carrying the signing link failed to send: ${r.error}`);
    }
    return { ok: false, error: `The proposal is marked sent, but the email didn't go out: ${r.error}` };
  }
  if (signatureRequestId) {
    const { recordSignatureEvent } = await import("@/lib/commercial/esign/db");
    await recordSignatureEvent(signatureRequestId, {
      type: "EMAIL",
      actorName: input.actor_name ?? null,
      actorEmail: input.actor_email ?? null,
      details: `Signing link emailed to ${toEmail}${ccEmail ? ` (cc ${ccEmail})` : ""} [Profile: Customer | Signing position: 1/2] with the proposal PDF attached.`,
    });
  }

  // Record the delivery.
  const { data: sendRow, error: insErr } = await sb
    .from("commercial_proposal_email_sends")
    .insert({
      proposal_id: input.proposal_id,
      opportunity_id: opp.id,
      account_id: opp.account_id,
      revision_number: proposal.revision_number,
      to_email: toEmail,
      cc_email: ccEmail,
      subject,
      resend_message_id: r.id,
      sent_by_user_id: input.actor_user_id,
      status: "sent",
    })
    .select("id, to_email, created_at")
    .single();
  if (insErr) {
    // The email DID go out — don't fail the whole action over a log-row hiccup.
    console.warn("[emailProposalToGc] send-record insert failed:", insErr.message);
  }

  // Account timeline note (system-posted, links back to the deal).
  try {
    const { addAccountNote } = await import("@/lib/commercial/account-notes");
    await addAccountNote({
      account_id: opp.account_id,
      body: `${proposalLabel(proposal)} emailed to ${toEmail}.`,
      kind: "auto_debrief",
      source_opportunity_id: opp.id,
      author_user_id: input.actor_user_id,
    });
  } catch (err) {
    console.warn("[emailProposalToGc] account note failed:", err);
  }

  return {
    ok: true,
    send: sendRow ?? { id: "", to_email: toEmail, created_at: new Date().toISOString() },
    signature: { included: !!signatureRequestId, note: signatureNote },
  };
}

/** The review-sheet message as HTML, plus a real button for the signing link.
 *  The plain-text part carries the same link for mail clients without HTML. */
function signingEmailHtml(message: string, url: string, companyName: string): string {
  const esc = (v: string) =>
    v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const paragraphs = message
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;">${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.55;color:#1f2937;max-width:560px;">
  ${paragraphs}
  <p style="margin:26px 0 8px;"><a href="${esc(url)}" style="display:inline-block;padding:12px 22px;background:#172B4D;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">Review &amp; sign the proposal</a></p>
  <p style="margin:0 0 20px;font-size:12.5px;color:#6b7280;">The link is personal to you and stays open for 30 days. The proposal PDF is also attached.</p>
  <p style="margin:0;font-size:12px;color:#9ca3af;">Sent by ${esc(companyName)}</p>
</div>`;
}

/** List email-send history for a proposal (newest first) — powers the
 *  "Emailed to … · date" line on the proposal detail. */
export type ProposalEmailSend = {
  id: string;
  to_email: string;
  cc_email: string | null;
  subject: string | null;
  revision_number: number | null;
  status: string;
  created_at: string;
};

export async function listProposalEmailSends(proposalId: string): Promise<ProposalEmailSend[]> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_proposal_email_sends")
    .select("id, to_email, cc_email, subject, revision_number, status, created_at")
    .eq("proposal_id", proposalId)
    .order("created_at", { ascending: false });
  return (data ?? []) as ProposalEmailSend[];
}
