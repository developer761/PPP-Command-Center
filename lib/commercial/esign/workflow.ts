import "server-only";

import { bumpDocumentVersion, uploadDocument, getDocument } from "@/lib/commercial/documents/db";
import { sanitizeFileName } from "@/lib/commercial/accounts/documents";
import { companyAddressLines, getOperatingCompany, type OperatingCompany } from "@/lib/commercial/operating-company/db";
import { getBrandLogoBuffer, getBrandSignatureBuffer } from "@/lib/commercial/operating-company/assets";
import { proposalLabel } from "@/lib/commercial/proposals/constants";
import { PROPOSAL_COPY_EMAILS } from "@/lib/commercial/proposals/copy-emails";
import { SIGNATURE_STATUS_LABEL } from "./constants";
import {
  downloadDocumentBytes,
  downloadStorageBytes,
  getProposalForSigning,
  getSignatureRequest,
  listSignatureEvents,
  proposalDisplayTitle,
  recordCountersignature,
  recordSignatureEvent,
  setSignatureDocuments,
  type ProposalForSigning,
  type SignatureRequest,
} from "./db";
import { assembleSignedDocument, renderAuditTrailPdf, renderSignaturePagePdf, type EsignCompany } from "./pdf";
import { sha256Hex } from "./token";

/**
 * E-signature side effects: the PDFs, the filing, the emails, the bells.
 *
 * Everything here runs AFTER `./db.ts` has written the record, and nothing
 * here can un-sign anything. Each step is best-effort and logged — except the
 * countersignature's own integrity check, which refuses outright, because a
 * contract assembled from a document that no longer matches its hash would be
 * a forgery with our name on it.
 */

type Meta = { ip: string | null; userAgent: string | null };

export function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || "https://hub.precisionpaintingplus.net").replace(/\/$/, "");
}

export function signingUrl(token: string): string {
  return `${appBaseUrl()}/sign/${token}`;
}

function esignCompany(oc: OperatingCompany): EsignCompany {
  return { name: oc.name, address_lines: companyAddressLines(oc), phone: oc.phone, website: oc.website };
}

function fileBase(p: ProposalForSigning): string {
  const project = p.header_json.project_name?.trim() || p.opportunity_title?.trim() || "Proposal";
  return sanitizeFileName(`${proposalLabel(p)} ${project}`) || "proposal";
}

/** Who a filing is attributed to. The public signer has no account, so the
 *  person who sent the link owns anything filed on the customer's behalf. */
function filer(r: SignatureRequest): string {
  return (r.countersigned_by_user_id ?? r.requested_by_user_id) as string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit trail
// ─────────────────────────────────────────────────────────────────────────────

export async function buildAuditTrailPdf(requestId: string): Promise<{ bytes: Buffer; request: SignatureRequest; proposal: ProposalForSigning } | null> {
  const request = await getSignatureRequest(requestId);
  if (!request) return null;
  const proposal = await getProposalForSigning(request.proposal_id);
  if (!proposal) return null;
  const [oc, logo, events] = await Promise.all([getOperatingCompany(), getBrandLogoBuffer(), listSignatureEvents(requestId)]);
  const base = appBaseUrl();

  const bytes = await renderAuditTrailPdf({
    company: esignCompany(oc),
    logo,
    requestId: request.id,
    documentTitle: proposalDisplayTitle(proposal),
    statusLabel: SIGNATURE_STATUS_LABEL[request.status],
    documentSha256: request.document_sha256,
    signedSha256: request.signed_sha256,
    requestedBy: [request.requested_by_name, request.requested_by_email ? `(${request.requested_by_email})` : null].filter(Boolean).join(" ") || "—",
    createdFrom: `${base}/commercial`,
    signedAt: `${base}/sign/`,
    signers: [
      {
        name: request.customer_name ?? request.signer_name ?? "—",
        email: request.signer_email,
        profile: "Customer",
        position: "1/2",
        ip: request.customer_ip,
        signedAt: request.customer_signed_at,
      },
      {
        name: request.countersigner_name ?? oc.signature_name ?? oc.name,
        email: request.countersigner_email ?? "—",
        // The stored signature belongs to the company signer; the email column
        // is the login that pressed Countersign. Said here in words, so the row
        // never reads as though that name and that email are one person. (In
        // the name cell it overflowed into the email column — an email address
        // has no break points.)
        profile: request.countersigner_email
          ? `${oc.name} Representative (signature on file, applied by the login shown)`
          : `${oc.name} Representative`,
        position: "2/2",
        ip: request.countersigner_ip,
        signedAt: request.countersigned_at,
      },
    ],
    events: events.map((e) => ({ at: e.at, type: e.type, details: e.details })),
    generatedAt: new Date().toISOString(),
  });
  return { bytes, request, proposal };
}

/**
 * File (or re-file) the audit trail against the deal. The first filing is
 * version 1; every later one is a new version of the same document, so the
 * deal's Files tab shows one audit trail per signature with its history behind
 * it, not a pile of near-duplicates.
 */
export async function fileAuditTrail(requestId: string): Promise<string | null> {
  const built = await buildAuditTrailPdf(requestId);
  if (!built) return null;
  const { bytes, request, proposal } = built;
  const file_name = `${fileBase(proposal)}-audit-trail.pdf`;
  const previous = request.audit_document_id ? await getDocument(request.audit_document_id) : null;
  const res = previous
    ? await bumpDocumentVersion({
        previous_document_id: previous.id,
        file_name,
        size_bytes: bytes.byteLength,
        mime_type: "application/pdf",
        notes: `E-signature audit trail · ${SIGNATURE_STATUS_LABEL[request.status]}`,
        data: new Uint8Array(bytes),
        uploaded_by_user_id: filer(request),
      })
    : await uploadDocument({
        parent_type: "opportunity",
        parent_id: request.opportunity_id,
        category: "esign_audit",
        file_name,
        size_bytes: bytes.byteLength,
        mime_type: "application/pdf",
        notes: `E-signature audit trail · ${SIGNATURE_STATUS_LABEL[request.status]}`,
        data: new Uint8Array(bytes),
        uploaded_by_user_id: filer(request),
      });
  if (!res.ok) {
    console.error(`[esign] audit trail NOT filed for request ${requestId}: ${res.error}`);
    return null;
  }
  await setSignatureDocuments(requestId, { audit_document_id: res.document.id });
  return res.document.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Emails to the signer
// ─────────────────────────────────────────────────────────────────────────────

async function emailSigner(input: {
  request: SignatureRequest;
  subject: string;
  text: string;
  eventDetails: string;
  attachments?: Array<{ filename: string; content: Buffer }>;
}): Promise<void> {
  const oc = await getOperatingCompany();
  /**
   * estimating@ — a signature request is part of the proposal conversation
   * (this module copies PROPOSAL_COPY_EMAILS for the same reason).
   *
   * It was falling through to the shared commercial pool, so the one email on
   * this platform that asks a customer to SIGN something arrived from
   * deals@orders.precisionpaintingplus.net — a domain the signer has no
   * relationship with, which is the worst possible sender for a request to
   * sign. Same defect Brendan reported on an invoice, 2026-09-21.
   */
  const fromAddr =
    process.env.COMMERCIAL_PROPOSAL_FROM_ADDRESS;
  const to = input.request.signer_email;
  const bcc = PROPOSAL_COPY_EMAILS.filter((e) => e !== to);
  const { sendEmail } = await import("@/lib/email/resend");
  // sendEmail THROWS when no API key is configured outside production. A mailer
  // that throws must not abort what comes after it — the signed contract still
  // has to file and the certificate still has to be re-issued.
  const r = await sendEmail({
    channel: "commercial",
    to,
    subject: input.subject,
    text: input.text,
    ...(fromAddr ? { from: `${oc.name} <${fromAddr}>` } : {}),
    ...(PROPOSAL_COPY_EMAILS.length > 0 ? { replyTo: PROPOSAL_COPY_EMAILS } : {}),
    ...(bcc.length > 0 ? { bcc } : {}),
    ...(input.attachments ? { attachments: input.attachments } : {}),
    tags: [
      { name: "kind", value: "proposal_esign" },
      { name: "signature_request", value: input.request.id },
    ],
  }).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
  if (!r.ok) {
    console.error(`[esign] email to ${to} failed for request ${input.request.id}: ${r.error}`);
    return;
  }
  await recordSignatureEvent(input.request.id, { type: "EMAIL", details: input.eventDetails });
}

// ─────────────────────────────────────────────────────────────────────────────
// Customer signed / declined
// ─────────────────────────────────────────────────────────────────────────────

export async function afterCustomerSigned(request: SignatureRequest, proposal: ProposalForSigning): Promise<void> {
  const oc = await getOperatingCompany();
  const title = proposalDisplayTitle(proposal);
  await Promise.allSettled([
    emailSigner({
      request,
      subject: `We received your signature — ${title}`,
      text: [
        `Hi ${request.customer_name?.split(/\s+/)[0] ?? ""},`.replace(" ,", ","),
        "",
        `Thank you. Your signature on ${title} was recorded on behalf of ${request.customer_company || proposal.header_json.gc_company || "your company"}.`,
        "",
        `${oc.name} will countersign it, and we'll email you the fully signed copy with its audit trail.`,
        "",
        `— ${oc.name}`,
      ].join("\n"),
      eventDetails: `Sent confirmation of the signature to ${request.signer_email} ${"[Profile: Customer | Signing position: 1/2]"}.`,
    }),
    import("@/lib/notifications/commercial-events").then(({ insertCommercialProposalSignatureNotifications }) =>
      insertCommercialProposalSignatureNotifications({
        event: "signed",
        proposalId: proposal.id,
        revisionNumber: proposal.revision_number,
        opportunityId: proposal.opportunity_id,
        gcCompany: request.customer_company || proposal.header_json.gc_company || null,
        signerName: request.customer_name ?? request.signer_email,
        actingUserId: null,
      })
    ),
    addNote(proposal, `${proposalLabel(proposal)} signed online by ${request.customer_name}${request.customer_company ? ` (${request.customer_company})` : ""} — waiting on a countersignature.`, request.requested_by_user_id),
  ]);
  // Filed last so the certificate carries the confirmation email.
  await fileAuditTrail(request.id);
}

export async function afterCustomerDeclined(request: SignatureRequest, proposal: ProposalForSigning): Promise<void> {
  await Promise.allSettled([
    import("@/lib/notifications/commercial-events").then(({ insertCommercialProposalSignatureNotifications }) =>
      insertCommercialProposalSignatureNotifications({
        event: "declined",
        proposalId: proposal.id,
        revisionNumber: proposal.revision_number,
        opportunityId: proposal.opportunity_id,
        gcCompany: proposal.header_json.gc_company || null,
        signerName: request.signer_name ?? request.signer_email,
        declineReason: request.decline_reason,
        actingUserId: null,
      })
    ),
    addNote(
      proposal,
      `${proposalLabel(proposal)} signature declined by ${request.signer_email}${request.decline_reason ? `: "${request.decline_reason}"` : "."}`,
      request.requested_by_user_id
    ),
  ]);
  await fileAuditTrail(request.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Countersign → completed
// ─────────────────────────────────────────────────────────────────────────────

export type CountersignResult =
  | { ok: true; request: SignatureRequest; filed: boolean; markedWon: boolean }
  | { ok: false; error: string };

export async function countersignProposal(input: {
  requestId: string;
  user: { id: string; email: string | null; name: string | null };
  meta: Meta;
}): Promise<CountersignResult> {
  const { isProposalApprover } = await import("@/lib/commercial/proposals/db");
  if (!(await isProposalApprover(input.user.id))) {
    return { ok: false, error: "Only a proposal approver can countersign." };
  }
  const request = await getSignatureRequest(input.requestId);
  if (!request) return { ok: false, error: "Signature request not found." };
  if (request.status !== "awaiting_countersign") {
    return { ok: false, error: "This signature is no longer waiting on a countersignature." };
  }
  // The customer signed THIS proposal while it was the offer. If it has since
  // been replaced by a revision, marked lost or deleted, executing it now would
  // make a contract out of a dead price — and a second one when the revision
  // is signed.
  const live = await getProposalForSigning(request.proposal_id);
  const blocked = countersignBlockedReason(live);
  if (blocked) return { ok: false, error: blocked };

  const [oc, companySignature, snapshot] = await Promise.all([
    getOperatingCompany(),
    getBrandSignatureBuffer(),
    request.document_id ? downloadDocumentBytes(request.document_id) : Promise.resolve(null),
  ]);
  if (!companySignature) {
    return { ok: false, error: "There's no signature on file yet. Add one in Settings → Operating company, then countersign." };
  }
  // The PDF renderer draws PNG and JPEG only; anything else (Settings accepts
  // WEBP) renders as an empty box under "Signed electronically by …".
  if (!isPngOrJpeg(companySignature)) {
    return { ok: false, error: "The signature on file isn't a PNG or JPEG, so it can't be printed. Redraw it in Settings → Operating company, then countersign." };
  }
  if (!snapshot || sha256Hex(snapshot) !== request.document_sha256) {
    console.error(`[esign] countersign refused: document integrity check FAILED for request ${request.id}`);
    return { ok: false, error: "The proposal document on file no longer matches what the customer signed, so it can't be countersigned. Void this signature and send the proposal again." };
  }

  const signerName = oc.signature_name?.trim() || input.user.name?.trim() || input.user.email || "Authorized signer";
  const recorded = await recordCountersignature({
    requestId: request.id,
    user: { id: input.user.id, email: input.user.email },
    signerName,
    signerTitle: oc.signature_title?.trim() || null,
    meta: input.meta,
  });
  if (!recorded.ok) return recorded;

  // The signature is recorded; nothing below may leave the proposal un-won or
  // the countersign bar standing because a PDF failed to render.
  let filed = false;
  try {
    filed = await finalizeCompletedRequest(recorded.request.id, { snapshot, companySignature });
  } catch (err) {
    console.error(`[esign] finalize threw for ${recorded.request.id}:`, err);
  }

  let markedWon = false;
  try {
    const proposal = await getProposalForSigning(request.proposal_id);
    if (proposal && proposal.status === "sent") {
      const { markProposalOutcome } = await import("@/lib/commercial/proposals/db");
      const won = await markProposalOutcome({ proposal_id: proposal.id, outcome: "won", actor_user_id: input.user.id });
      markedWon = won.ok;
      if (!won.ok) console.warn(`[esign] signed proposal ${proposal.id} not marked won: ${won.error}`);
    }
  } catch (err) {
    console.error(`[esign] mark-won threw for proposal ${request.proposal_id}:`, err);
  }

  const { clearApprovalRequestNotifications } = await import("@/lib/notifications/commercial-events");
  await clearApprovalRequestNotifications(request.proposal_id, "commercial_proposal_signed");


  return { ok: true, request: (await getSignatureRequest(request.id)) ?? recorded.request, filed, markedWon };
}

/**
 * Build and file the signed contract + final audit trail, and send both to the
 * customer. Idempotent: a completed request that already has its signed
 * document skips the build, so a failed filing can be retried from the page.
 */
export async function finalizeCompletedRequest(
  requestId: string,
  preloaded?: { snapshot: Buffer; companySignature: Buffer }
): Promise<boolean> {
  let request = await getSignatureRequest(requestId);
  if (!request || request.status !== "completed") return false;
  const proposal = await getProposalForSigning(request.proposal_id);
  if (!proposal) return false;

  let signedBytes: Buffer | null = null;
  if (!request.signed_document_id) {
    const [oc, logo, snapshot, companySignature, customerSignature] = await Promise.all([
      getOperatingCompany(),
      getBrandLogoBuffer(),
      preloaded ? Promise.resolve(preloaded.snapshot) : request.document_id ? downloadDocumentBytes(request.document_id) : Promise.resolve(null),
      preloaded ? Promise.resolve(preloaded.companySignature) : getBrandSignatureBuffer(),
      downloadStorageBytes(request.customer_signature_key),
    ]);
    if (!snapshot || sha256Hex(snapshot) !== request.document_sha256 || !companySignature || !customerSignature) {
      console.error(`[esign] cannot assemble signed document for ${requestId}: missing or mismatched inputs`);
      return false;
    }
    // The customer's mark must be the one they submitted, not whatever sits at
    // that storage key days later.
    if (request.customer_signature_sha256 && sha256Hex(customerSignature) !== request.customer_signature_sha256) {
      console.error(`[esign] customer signature image integrity check FAILED for ${requestId}`);
      return false;
    }
    const signaturePage = await renderSignaturePagePdf({
      company: esignCompany(oc),
      logo,
      requestId: request.id,
      proposalLabel: proposalLabel(proposal),
      proposalNumber: proposal.header_json.proposal_number?.trim() || proposal.project_number || null,
      projectName: proposal.header_json.project_name?.trim() || proposal.opportunity_title,
      gcCompany: proposal.header_json.gc_company?.trim() || null,
      proposalDate: proposal.header_json.date_iso ?? null,
      documentSha256: request.document_sha256,
      customer: {
        name: request.customer_name ?? request.signer_email,
        title: request.customer_title,
        company: request.customer_company,
        email: request.signer_email,
        signedAt: request.customer_signed_at!,
        signature: customerSignature,
      },
      contractor: {
        name: request.countersigner_name ?? oc.name,
        title: request.countersigner_title,
        signedAt: request.countersigned_at!,
        signature: companySignature,
        appliedBy: request.countersigner_email,
      },
    });
    signedBytes = await assembleSignedDocument(snapshot, signaturePage);
    const signedSha = sha256Hex(signedBytes);
    const up = await uploadDocument({
      parent_type: "opportunity",
      parent_id: request.opportunity_id,
      category: "contract",
      file_name: `${fileBase(proposal)}-signed.pdf`,
      size_bytes: signedBytes.byteLength,
      mime_type: "application/pdf",
      notes: `Signed by ${request.customer_name} and ${request.countersigner_name}. SHA-256 ${signedSha}`,
      data: new Uint8Array(signedBytes),
      uploaded_by_user_id: filer(request),
    });
    if (!up.ok) {
      console.error(`[esign] signed contract NOT filed for ${requestId}: ${up.error}`);
      return false;
    }
    await setSignatureDocuments(requestId, { signed_document_id: up.document.id, signed_sha256: signedSha });
    await recordSignatureEvent(requestId, {
      type: "COMPLETE",
      details: `Created the signed document (proposal + signature page) and stored it with Document ID ${up.document.id}. Its SHA-256 is the Unique ID above.`,
    });
    request = (await getSignatureRequest(requestId)) ?? request;
  } else {
    signedBytes = await downloadDocumentBytes(request.signed_document_id);
  }

  const auditId = await fileAuditTrail(requestId);
  const auditBytes = auditId ? await downloadDocumentBytes(auditId) : null;

  // Only on the first completion — a retry of the filing must not re-send.
  const events = await listSignatureEvents(requestId);
  const alreadySent = events.some((e) => e.type === "EMAIL" && e.details.startsWith("Sent the fully signed"));
  if (!alreadySent && signedBytes) {
    const oc = await getOperatingCompany();
    const title = proposalDisplayTitle(proposal);
    const base = fileBase(proposal);
    await emailSigner({
      request,
      subject: `Fully signed — ${title}`,
      text: [
        `Hi ${request.customer_name?.split(/\s+/)[0] ?? ""},`.replace(" ,", ","),
        "",
        `${title} is now signed by both parties. The signed copy and its audit trail are attached for your records.`,
        "",
        `Thank you for the work — we look forward to it.`,
        "",
        `— ${oc.name}`,
      ].join("\n"),
      attachments: [
        { filename: `${base}-signed.pdf`, content: signedBytes },
        ...(auditBytes ? [{ filename: `${base}-audit-trail.pdf`, content: auditBytes }] : []),
      ],
      eventDetails: `Sent the fully signed document${auditBytes ? " and audit trail" : ""} to ${request.signer_email} [Profile: Customer | Signing position: 1/2].`,
    });
    // The certificate should carry that email too.
    await fileAuditTrail(requestId);

    await Promise.allSettled([
      import("@/lib/notifications/commercial-events").then(({ insertCommercialProposalSignatureNotifications }) =>
        insertCommercialProposalSignatureNotifications({
          event: "completed",
          proposalId: proposal.id,
          revisionNumber: proposal.revision_number,
          opportunityId: proposal.opportunity_id,
          gcCompany: request!.customer_company || proposal.header_json.gc_company || null,
          signerName: request!.customer_name ?? request!.signer_email,
          actingUserId: request!.countersigned_by_user_id,
        })
      ),
      addNote(
        proposal,
        `${proposalLabel(proposal)} fully signed — ${request.customer_name} for the customer, ${request.countersigner_name} for ${oc.name}. Signed copy + audit trail filed.`,
        request.countersigned_by_user_id
      ),
    ]);
  }
  return true;
}

async function addNote(proposal: ProposalForSigning, body: string, authorUserId: string | null): Promise<void> {
  if (!proposal.account_id) return;
  try {
    const { addAccountNote } = await import("@/lib/commercial/account-notes");
    await addAccountNote({
      account_id: proposal.account_id,
      body,
      kind: "auto_debrief",
      source_opportunity_id: proposal.opportunity_id,
      author_user_id: authorUserId ?? undefined,
    });
  } catch (err) {
    console.warn("[esign] account note failed:", err);
  }
}

/** Why a signed request can't be countersigned right now, or null if it can.
 *  Shared by the action and the panel so the button never offers what the
 *  action will refuse. */
export function countersignBlockedReason(proposal: Pick<ProposalForSigning, "status" | "deleted_at"> | null): string | null {
  if (!proposal || proposal.deleted_at) return "This proposal (or its deal) was deleted, so the signature can't be countersigned. Void it instead.";
  if (proposal.status === "superseded") return "A newer revision replaced this proposal, so this signature can't be countersigned. Void it and have the customer sign the current revision.";
  if (proposal.status !== "sent" && proposal.status !== "won") {
    return `This proposal is ${proposal.status}, so the signature can't be countersigned. Void it instead.`;
  }
  return null;
}

export function isPngOrJpeg(b: Uint8Array): boolean {
  const png = b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const jpeg = b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  return png || jpeg;
}
