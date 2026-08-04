import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { getProposal, sendProposal, type CommercialProposal } from "./db";
import { getDocument, STORAGE_BUCKET } from "@/lib/commercial/documents/db";
import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { sanitizeFileName } from "@/lib/commercial/accounts/documents";

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
};

export type EmailProposalResult =
  | { ok: true; send: { id: string; to_email: string; created_at: string } }
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
  const fromAddr = process.env.COMMERCIAL_RESEND_FROM_ADDRESS || process.env.RESEND_FROM_ADDRESS;
  const from = fromAddr ? `${oc.name} <${fromAddr}>` : undefined;
  const replyTo = oc.email || input.actor_email || undefined;

  const projectLabel =
    proposal.header_json.project_name?.trim() || proposal.header_json.gc_company?.trim() || "Proposal";
  const filename = `${sanitizeFileName(`Proposal_${projectLabel}_R${proposal.revision_number}`)}.pdf`;

  const { sendEmail } = await import("@/lib/email/resend");
  const r = await sendEmail({
    channel: "commercial",
    to: toEmail,
    ...(ccEmail ? { cc: ccEmail } : {}),
    subject,
    text: message,
    ...(from ? { from } : {}),
    ...(replyTo ? { replyTo } : {}),
    attachments: [{ filename, content: pdf }],
    tags: [
      { name: "kind", value: "proposal_to_gc" },
      { name: "proposal", value: input.proposal_id },
    ],
  });
  if (!r.ok) {
    return { ok: false, error: `The proposal is marked sent, but the email didn't go out: ${r.error}` };
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
      body: `Proposal R${proposal.revision_number} emailed to ${toEmail}.`,
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
  };
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
