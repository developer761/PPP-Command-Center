import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { STORAGE_BUCKET } from "@/lib/commercial/documents/db";
import { proposalLabel } from "@/lib/commercial/proposals/constants";
import { etDateOf } from "@/lib/date-et";
import {
  DECLINE_REASON_MAX,
  isSignatureTokenShaped,
  resolveLinkState,
  SIGNATURE_LINK_TTL_DAYS,
  SIGNATURE_PNG_MAX_BYTES,
  SIGNER_FIELD_MAX,
  type LinkState,
  type SignatureEventType,
  type SignatureRequestStatus,
} from "./constants";
import { generateSignatureToken, hashSignatureToken, sha256Hex } from "./token";

/**
 * Commercial proposal e-signature — the records.
 *
 * Every state change here is a conditional UPDATE filtered on the status it is
 * leaving (`.eq("status", from)`), so two tabs, a double-tap or a re-sent link
 * can't both win. The partial unique index on `(proposal_id) WHERE status IN
 * (awaiting_countersign, completed)` is the backstop across DIFFERENT requests
 * for the same proposal.
 *
 * Side effects — filing PDFs, emails, bells — live in `./workflow.ts` and run
 * AFTER the record is written. A signature that is recorded but whose
 * confirmation email failed is still a signature; the reverse would be a lie.
 */

export type SignatureRequest = {
  id: string;
  proposal_id: string;
  opportunity_id: string;
  revision_number: number;
  token_hash: string;
  status: SignatureRequestStatus;
  expires_at: string;
  signer_email: string;
  signer_name: string | null;
  document_id: string | null;
  document_sha256: string;
  requested_by_user_id: string | null;
  requested_by_name: string | null;
  requested_by_email: string | null;
  customer_name: string | null;
  customer_title: string | null;
  customer_company: string | null;
  customer_signature_method: "typed" | "drawn" | null;
  customer_signature_key: string | null;
  customer_signature_sha256: string | null;
  customer_signed_at: string | null;
  customer_ip: string | null;
  customer_user_agent: string | null;
  declined_at: string | null;
  decline_reason: string | null;
  countersigned_by_user_id: string | null;
  countersigner_name: string | null;
  countersigner_title: string | null;
  countersigner_email: string | null;
  countersigned_at: string | null;
  countersigner_ip: string | null;
  countersigner_user_agent: string | null;
  signed_document_id: string | null;
  signed_sha256: string | null;
  audit_document_id: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type SignatureEvent = {
  id: number;
  request_id: string;
  at: string;
  type: SignatureEventType;
  actor_name: string | null;
  actor_email: string | null;
  ip: string | null;
  user_agent: string | null;
  details: string;
};

type Meta = { ip: string | null; userAgent: string | null };

const REQUESTS = "commercial_signature_requests";
const EVENTS = "commercial_signature_events";

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Append one audit event. Never throws: the action it describes has already
 * happened, and failing that action over a log row would be backwards. A
 * failure is logged loudly instead, because a missing row is a hole in a legal
 * record.
 */
export async function recordSignatureEvent(
  requestId: string,
  e: {
    type: SignatureEventType;
    details: string;
    actorName?: string | null;
    actorEmail?: string | null;
    ip?: string | null;
    userAgent?: string | null;
  }
): Promise<void> {
  try {
    const { error } = await commercialDb().from(EVENTS).insert({
      request_id: requestId,
      type: e.type,
      details: e.details.slice(0, 4000),
      actor_name: e.actorName ?? null,
      actor_email: e.actorEmail ?? null,
      ip: e.ip ?? null,
      user_agent: e.userAgent ?? null,
    });
    if (error) {
      console.error(`[esign] audit event ${e.type} NOT recorded for request ${requestId}: ${error.message}`);
    }
  } catch (err) {
    console.error(`[esign] audit event ${e.type} NOT recorded for request ${requestId}:`, err);
  }
}

export async function listSignatureEvents(requestId: string): Promise<SignatureEvent[]> {
  const { data } = await commercialDb()
    .from(EVENTS)
    .select("*")
    .eq("request_id", requestId)
    .order("at", { ascending: true })
    .order("id", { ascending: true });
  return (data ?? []) as SignatureEvent[];
}

/** "[Customer | Signing position 1/2]" — the bracket every signer event carries. */
export function signerTag(role: "customer" | "contractor"): string {
  return role === "customer" ? "[Profile: Customer | Signing position: 1/2]" : "[Profile: Contractor | Signing position: 2/2]";
}

function deviceClause(meta: Meta): string {
  return `from a device with IP address ${meta.ip ?? "unknown"} and browser with user agent string ${meta.userAgent ?? "unknown"}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

export async function getSignatureRequest(id: string): Promise<SignatureRequest | null> {
  const { data } = await commercialDb().from(REQUESTS).select("*").eq("id", id).maybeSingle();
  return (data as SignatureRequest | null) ?? null;
}

export async function listSignatureRequestsForProposal(proposalId: string): Promise<SignatureRequest[]> {
  const { data } = await commercialDb()
    .from(REQUESTS)
    .select("*")
    .eq("proposal_id", proposalId)
    .order("created_at", { ascending: false });
  return (data ?? []) as SignatureRequest[];
}

/** The signed (or signing) request for a proposal, if there is one. */
export async function getSignedRequestForProposal(proposalId: string): Promise<SignatureRequest | null> {
  const { data } = await commercialDb()
    .from(REQUESTS)
    .select("*")
    .eq("proposal_id", proposalId)
    .in("status", ["awaiting_countersign", "completed"])
    .maybeSingle();
  return (data as SignatureRequest | null) ?? null;
}

export type ProposalForSigning = {
  id: string;
  opportunity_id: string;
  revision_number: number;
  status: string;
  deleted_at: string | null;
  header_json: {
    gc_company?: string;
    attention?: string;
    project_name?: string;
    project_address?: string;
    date_iso?: string;
    proposal_number?: string;
    email?: string;
  };
  snapshot_document_id: string | null;
  project_number: string | null;
  account_id: string | null;
  opportunity_title: string | null;
};

const PROPOSAL_FOR_SIGNING_COLS =
  "id, opportunity_id, revision_number, status, deleted_at, header_json, snapshot_document_id, opportunity:commercial_opportunities!commercial_proposals_opportunity_id_fkey(project_number, account_id, title, deleted_at)";

export async function getProposalForSigning(
  proposalId: string,
  opts?: { throwOnError?: boolean }
): Promise<ProposalForSigning | null> {
  const { data, error } = await commercialDb()
    .from("commercial_proposals")
    .select(PROPOSAL_FOR_SIGNING_COLS)
    .eq("id", proposalId)
    .maybeSingle();
  if (error && opts?.throwOnError) throw new Error(error.message);
  if (!data) return null;
  return toProposalForSigning(data);
}

function toProposalForSigning(data: unknown): ProposalForSigning {
  const row = data as unknown as Omit<ProposalForSigning, "project_number" | "account_id" | "opportunity_title"> & {
    opportunity:
      | { project_number: string | null; account_id: string | null; title: string | null; deleted_at: string | null }
      | Array<{ project_number: string | null; account_id: string | null; title: string | null; deleted_at: string | null }>
      | null;
  };
  const opp = Array.isArray(row.opportunity) ? row.opportunity[0] ?? null : row.opportunity;
  return {
    id: row.id,
    opportunity_id: row.opportunity_id,
    revision_number: row.revision_number,
    status: row.status,
    // A proposal on a deleted deal is as dead as a deleted proposal.
    deleted_at: row.deleted_at ?? opp?.deleted_at ?? null,
    header_json: row.header_json ?? {},
    snapshot_document_id: row.snapshot_document_id,
    project_number: opp?.project_number ?? null,
    account_id: opp?.account_id ?? null,
    opportunity_title: opp?.title ?? null,
  };
}

export function proposalDisplayTitle(p: Pick<ProposalForSigning, "revision_number" | "header_json" | "opportunity_title">): string {
  const project = p.header_json.project_name?.trim() || p.opportunity_title?.trim() || "Proposal";
  return `${proposalLabel(p)} — ${project}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Create
// ─────────────────────────────────────────────────────────────────────────────

export type CreateSignatureRequestResult =
  | { ok: true; request: SignatureRequest; token: string }
  | { ok: false; reason: "already_signed" | "no_document" | "error"; error: string };

/**
 * Open a signing link for a sent proposal's snapshot.
 *
 * The snapshot is hashed HERE, at issue time, from the stored bytes — that hash
 * is the promise "this is the document you were asked to sign", and signing
 * re-checks it.
 */
export async function createSignatureRequest(input: {
  proposalId: string;
  signerEmail: string;
  signerName: string | null;
  requestedBy: { userId: string; name: string | null; email: string | null };
  ttlDays?: number;
}): Promise<CreateSignatureRequestResult> {
  const sb = commercialDb();
  const proposal = await getProposalForSigning(input.proposalId);
  if (!proposal || proposal.deleted_at) return { ok: false, reason: "error", error: "Proposal not found." };
  if (proposal.status !== "sent" && proposal.status !== "won") {
    return { ok: false, reason: "error", error: `A ${proposal.status} proposal can't be sent for signature.` };
  }
  const existing = await getSignedRequestForProposal(proposal.id);
  if (existing) {
    return { ok: false, reason: "already_signed", error: "This proposal has already been signed." };
  }
  if (!proposal.snapshot_document_id) {
    return { ok: false, reason: "no_document", error: "No PDF is on file for this proposal." };
  }
  const bytes = await downloadDocumentBytes(proposal.snapshot_document_id);
  if (!bytes) return { ok: false, reason: "no_document", error: "The proposal PDF couldn't be read." };

  const { token, hash } = generateSignatureToken();
  const ttl = input.ttlDays ?? SIGNATURE_LINK_TTL_DAYS;
  const { data, error } = await sb
    .from(REQUESTS)
    .insert({
      proposal_id: proposal.id,
      opportunity_id: proposal.opportunity_id,
      revision_number: proposal.revision_number,
      token_hash: hash,
      status: "awaiting_customer",
      expires_at: new Date(Date.now() + ttl * 86_400_000).toISOString(),
      signer_email: input.signerEmail.trim().toLowerCase(),
      signer_name: input.signerName?.trim() || null,
      document_id: proposal.snapshot_document_id,
      document_sha256: sha256Hex(bytes),
      requested_by_user_id: input.requestedBy.userId,
      requested_by_name: input.requestedBy.name,
      requested_by_email: input.requestedBy.email,
    })
    .select("*")
    .single();
  if (error || !data) return { ok: false, reason: "error", error: error?.message ?? "Couldn't create the signing link." };
  const request = data as SignatureRequest;

  await recordSignatureEvent(request.id, {
    type: "CREATE",
    actorName: input.requestedBy.name,
    actorEmail: input.requestedBy.email,
    details: `${input.requestedBy.name ?? "A team member"}${input.requestedBy.email ? ` (${input.requestedBy.email})` : ""} created an e-signature request for ${proposalDisplayTitle(proposal)} and fingerprinted the proposal PDF (SHA-256 above).`,
  });
  return { ok: true, request, token };
}

/** Undo a request whose email never went out, so it can't sit "awaiting" a
 *  signature from someone who was never asked. */
export async function voidUnsentRequest(requestId: string, reason: string): Promise<void> {
  await transition(requestId, "awaiting_customer", "voided", {
    voided_at: new Date().toISOString(),
    void_reason: reason,
  });
  await recordSignatureEvent(requestId, { type: "VOID", details: reason });
}

// ─────────────────────────────────────────────────────────────────────────────
// Link lookup (public)
// ─────────────────────────────────────────────────────────────────────────────

export type LinkLookup =
  | { found: false; reason: "malformed" | "not_found" | "unavailable" }
  | { found: true; request: SignatureRequest; proposal: ProposalForSigning; state: LinkState };

/**
 * Resolve a signing link. A link whose proposal has moved on, or whose 30 days
 * are up, is closed HERE and the closure is written to the trail — so the
 * certificate shows why a request stopped, not just that it did.
 */
export async function lookupSignatureLink(token: string | null | undefined): Promise<LinkLookup> {
  if (!isSignatureTokenShaped(token)) return { found: false, reason: "malformed" };
  let request: SignatureRequest | null;
  try {
    const { data, error } = await commercialDb()
      .from(REQUESTS)
      .select("*")
      .eq("token_hash", hashSignatureToken(token))
      .maybeSingle();
    // A database error is not "this link doesn't exist" — telling a GC their
    // valid link is bad during an outage sends them away for good.
    if (error) return { found: false, reason: "unavailable" };
    request = (data as SignatureRequest | null) ?? null;
  } catch {
    return { found: false, reason: "unavailable" };
  }
  if (!request) return { found: false, reason: "not_found" };

  let proposal: ProposalForSigning | null;
  try {
    proposal = await getProposalForSigning(request.proposal_id, { throwOnError: true });
  } catch {
    return { found: false, reason: "unavailable" };
  }
  if (!proposal) return { found: false, reason: "not_found" };

  let state = resolveLinkState({
    status: request.status,
    expiresAt: request.expires_at,
    proposalStatus: proposal.status,
    proposalDeleted: !!proposal.deleted_at,
  });

  // Another link for this proposal already carries the signature: this one is
  // done, whatever it says.
  if (state.kind === "sign") {
    const signed = await getSignedRequestForProposal(proposal.id);
    if (signed && signed.id !== request.id) {
      state = { kind: "voided", persist: true, reason: "The proposal was signed through another link." };
    }
  }

  if (state.kind === "expired" && state.persist) {
    if (await transition(request.id, "awaiting_customer", "expired", {})) {
      await recordSignatureEvent(request.id, {
        type: "EXPIRE",
        details: `The signing link expired unsigned after ${SIGNATURE_LINK_TTL_DAYS} days.`,
      });
      request = { ...request, status: "expired" };
    }
  } else if (state.kind === "voided" && state.persist) {
    if (await transition(request.id, "awaiting_customer", "voided", { voided_at: new Date().toISOString(), void_reason: state.reason })) {
      await recordSignatureEvent(request.id, { type: "VOID", details: state.reason });
      request = { ...request, status: "voided", void_reason: state.reason };
    }
  }
  return { found: true, request, proposal, state };
}

/** The stored snapshot bytes for a request — what the signing page shows. */
export async function readRequestDocument(request: SignatureRequest): Promise<Buffer | null> {
  if (!request.document_id) return null;
  return downloadDocumentBytes(request.document_id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Customer: view / consent / sign / decline
// ─────────────────────────────────────────────────────────────────────────────

export async function recordCustomerPresence(
  lookup: Extract<LinkLookup, { found: true }>,
  kind: "VIEW" | "CONSENT",
  meta: Meta
): Promise<void> {
  const r = lookup.request;
  // A reload, a second tap on the email link, a phone that re-renders the tab:
  // each is not new evidence. The same event from the same address inside ten
  // minutes is skipped, so the trail records visits, not refreshes.
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  let recent = commercialDb().from(EVENTS).select("id").eq("request_id", r.id).eq("type", kind).gte("at", since).limit(1);
  recent = meta.ip ? recent.eq("ip", meta.ip) : recent.is("ip", null);
  const { data: dup } = await recent;
  if ((dup ?? []).length > 0) return;
  const details =
    kind === "VIEW"
      ? `Signing page intended for ${r.signer_email} ${signerTag("customer")} opened ${deviceClause(meta)}.`
      : `Consent to do business electronically given on the signing page intended for ${r.signer_email} ${signerTag("customer")}.`;
  await recordSignatureEvent(r.id, {
    type: kind,
    actorEmail: r.signer_email,
    ip: meta.ip,
    userAgent: meta.userAgent,
    details,
  });
}

export type SubmitSignatureInput = {
  token: string;
  name: string;
  title: string;
  company: string;
  method: "typed" | "drawn";
  png: Uint8Array;
  consent: boolean;
  meta: Meta;
};

export type SubmitSignatureResult =
  | { ok: true; request: SignatureRequest; proposal: ProposalForSigning }
  | { ok: false; status: number; error: string };

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function validateSignerFields(input: {
  name: string;
  title: string;
  company: string;
  method: string;
  png: Uint8Array;
  consent: boolean;
}): string | null {
  const name = input.name.trim();
  if (!input.consent) return "Agree to sign electronically first.";
  if (name.length < 2) return "Enter your full name.";
  if (name.length > SIGNER_FIELD_MAX || input.title.length > SIGNER_FIELD_MAX || input.company.length > SIGNER_FIELD_MAX) {
    return `Keep each field under ${SIGNER_FIELD_MAX} characters.`;
  }
  if (input.method !== "typed" && input.method !== "drawn") return "Choose how to sign.";
  if (input.png.byteLength === 0) return "Add your signature.";
  if (input.png.byteLength > SIGNATURE_PNG_MAX_BYTES) return "That signature image is too large — clear it and sign again.";
  if (!PNG_MAGIC.every((b, i) => input.png[i] === b)) return "The signature didn't come through — sign again.";
  // A few-KB PNG can DECLARE a gigantic canvas, and the PDF renderer unpacks
  // every pixel — enough to run the countersign out of memory, every retry.
  // Width/height sit big-endian in the IHDR chunk at bytes 16-23.
  if (input.png.byteLength < 24) return "The signature didn't come through — sign again.";
  const view = new DataView(input.png.buffer, input.png.byteOffset, input.png.byteLength);
  const w = view.getUint32(16);
  const h = view.getUint32(20);
  if (w === 0 || h === 0 || w > SIGNATURE_MAX_WIDTH || h > SIGNATURE_MAX_HEIGHT) {
    return "That signature image is too large — clear it and sign again.";
  }
  return null;
}

/** Generous for a 3× phone screen, far below what could exhaust memory. */
const SIGNATURE_MAX_WIDTH = 4000;
const SIGNATURE_MAX_HEIGHT = 1500;

export async function submitCustomerSignature(input: SubmitSignatureInput): Promise<SubmitSignatureResult> {
  const invalid = validateSignerFields(input);
  if (invalid) return { ok: false, status: 400, error: invalid };

  const lookup = await lookupSignatureLink(input.token);
  if (!lookup.found) {
    return lookup.reason === "unavailable"
      ? { ok: false, status: 503, error: "We couldn't reach our records just now. Please try again in a minute." }
      : { ok: false, status: 404, error: "This signing link isn't valid." };
  }
  if (lookup.state.kind !== "sign") return { ok: false, status: 409, error: closedLinkMessage(lookup.state) };
  const { request, proposal } = lookup;

  // The document must be byte-identical to the one this link was issued for.
  const bytes = await readRequestDocument(request);
  if (!bytes || sha256Hex(bytes) !== request.document_sha256) {
    console.error(`[esign] document integrity check FAILED for request ${request.id}`);
    return {
      ok: false,
      status: 409,
      error: "This proposal's document has changed since the link was sent, so it can't be signed. Please contact us for a fresh link.",
    };
  }

  const sb = commercialDb();
  const signedAt = new Date().toISOString();
  const sigKey = `esign/${request.id}/customer-signature-${Date.now()}.png`;
  const { error: upErr } = await sb.storage
    .from(STORAGE_BUCKET)
    .upload(sigKey, input.png, { contentType: "image/png", upsert: false });
  if (upErr) return { ok: false, status: 500, error: "We couldn't save your signature. Please try again." };

  const { data, error } = await sb
    .from(REQUESTS)
    .update({
      status: "awaiting_countersign",
      customer_name: input.name.trim(),
      customer_title: input.title.trim() || null,
      customer_company: input.company.trim() || null,
      customer_signature_method: input.method,
      customer_signature_key: sigKey,
      customer_signature_sha256: sha256Hex(input.png),
      customer_signed_at: signedAt,
      customer_ip: input.meta.ip,
      customer_user_agent: input.meta.userAgent,
    })
    .eq("id", request.id)
    .eq("status", "awaiting_customer")
    .select("*")
    .maybeSingle();

  if (error || !data) {
    await sb.storage.from(STORAGE_BUCKET).remove([sigKey]).catch(() => {});
    // 23505 = the one-signature-per-proposal index: another link won the race.
    if (error?.code === "23505" || !data) {
      return { ok: false, status: 409, error: "This proposal has already been signed." };
    }
    return { ok: false, status: 500, error: "We couldn't record your signature. Please try again." };
  }
  const signed = data as SignatureRequest;

  await recordSignatureEvent(signed.id, {
    type: "SUBMIT",
    actorName: signed.customer_name,
    actorEmail: signed.signer_email,
    ip: input.meta.ip,
    userAgent: input.meta.userAgent,
    details: [
      `Document reviewed and signed by ${signed.customer_name}${signed.customer_title ? `, ${signed.customer_title}` : ""}${signed.customer_company ? ` (${signed.customer_company})` : ""} on the signing page intended for ${signed.signer_email} ${signerTag("customer")}, ${deviceClause(input.meta)}.`,
      `Signature ${input.method === "typed" ? "typed" : "drawn by hand"}; the document's SHA-256 matched the copy sent.`,
    ].join(" "),
  });

  // Every other open link for this proposal is now moot.
  const { data: siblings } = await sb
    .from(REQUESTS)
    .select("id")
    .eq("proposal_id", signed.proposal_id)
    .eq("status", "awaiting_customer")
    .neq("id", signed.id);
  for (const sib of (siblings ?? []) as Array<{ id: string }>) {
    const reason = `The proposal was signed through another link (request ${signed.id}).`;
    if (await transition(sib.id, "awaiting_customer", "voided", { voided_at: signedAt, void_reason: reason })) {
      await recordSignatureEvent(sib.id, { type: "VOID", details: reason });
    }
  }

  return { ok: true, request: signed, proposal };
}

export async function declineSignature(input: {
  token: string;
  reason: string;
  meta: Meta;
}): Promise<{ ok: true; request: SignatureRequest; proposal: ProposalForSigning } | { ok: false; status: number; error: string }> {
  const reason = input.reason.trim().slice(0, DECLINE_REASON_MAX);
  const lookup = await lookupSignatureLink(input.token);
  if (!lookup.found) {
    return lookup.reason === "unavailable"
      ? { ok: false, status: 503, error: "We couldn't reach our records just now. Please try again in a minute." }
      : { ok: false, status: 404, error: "This signing link isn't valid." };
  }
  if (lookup.state.kind !== "sign") return { ok: false, status: 409, error: closedLinkMessage(lookup.state) };

  const now = new Date().toISOString();
  const ok = await transition(lookup.request.id, "awaiting_customer", "declined", {
    declined_at: now,
    decline_reason: reason || null,
  });
  if (!ok) return { ok: false, status: 409, error: "This link has already been used." };
  await recordSignatureEvent(lookup.request.id, {
    type: "DECLINE",
    actorEmail: lookup.request.signer_email,
    ip: input.meta.ip,
    userAgent: input.meta.userAgent,
    details: `Signer ${lookup.request.signer_email} ${signerTag("customer")} declined to sign ${deviceClause(input.meta)}.${reason ? ` Reason given: "${reason}"` : " No reason given."}`,
  });
  return {
    ok: true,
    request: { ...lookup.request, status: "declined", declined_at: now, decline_reason: reason || null },
    proposal: lookup.proposal,
  };
}

export function closedLinkMessage(state: LinkState): string {
  switch (state.kind) {
    case "signed":
      return "This proposal has already been signed.";
    case "declined":
      return "This signing request was declined.";
    case "expired":
      return "This signing link has expired. Please contact us for a fresh link.";
    case "voided":
      return "This signing link is no longer active. Please contact us for the current proposal.";
    case "sign":
      return "";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Contractor: countersign / void
// ─────────────────────────────────────────────────────────────────────────────

export async function recordCountersignature(input: {
  requestId: string;
  user: { id: string; email: string | null };
  signerName: string;
  signerTitle: string | null;
  meta: Meta;
}): Promise<{ ok: true; request: SignatureRequest } | { ok: false; error: string }> {
  const now = new Date().toISOString();
  const { data, error } = await commercialDb()
    .from(REQUESTS)
    .update({
      status: "completed",
      countersigned_by_user_id: input.user.id,
      countersigner_name: input.signerName,
      countersigner_title: input.signerTitle,
      countersigner_email: input.user.email,
      countersigned_at: now,
      countersigner_ip: input.meta.ip,
      countersigner_user_agent: input.meta.userAgent,
    })
    .eq("id", input.requestId)
    .eq("status", "awaiting_countersign")
    .select("*")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "This signature is no longer waiting on a countersignature." };
  const request = data as SignatureRequest;
  await recordSignatureEvent(request.id, {
    type: "COUNTERSIGN",
    actorName: input.signerName,
    actorEmail: input.user.email,
    ip: input.meta.ip,
    userAgent: input.meta.userAgent,
    details: `Countersigned as ${input.signerName}${input.signerTitle ? `, ${input.signerTitle}` : ""} by ${input.user.email ?? "a team member"} ${signerTag("contractor")} using the signature on file, ${deviceClause(input.meta)}.`,
  });
  return { ok: true, request };
}

export async function voidSignatureRequest(input: {
  requestId: string;
  reason: string;
  user: { id: string; name: string | null; email: string | null };
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const reason = input.reason.trim().slice(0, DECLINE_REASON_MAX);
  if (!reason) return { ok: false, error: "Say why the signature is being voided — it goes on the audit trail." };
  const current = await getSignatureRequest(input.requestId);
  if (!current) return { ok: false, error: "Signature request not found." };
  if (current.status !== "awaiting_customer" && current.status !== "awaiting_countersign") {
    return { ok: false, error: "Only an open signature request can be voided." };
  }
  // Pulling back an unanswered link is routine (wrong contact). Throwing away
  // a customer's signature is the same authority as countersigning it.
  if (current.status === "awaiting_countersign") {
    const { isProposalApprover } = await import("@/lib/commercial/proposals/db");
    if (!(await isProposalApprover(input.user.id))) {
      return { ok: false, error: "The customer has signed — only a proposal approver can void it." };
    }
  }
  const ok = await transition(input.requestId, current.status, "voided", {
    voided_at: new Date().toISOString(),
    void_reason: reason,
  });
  if (!ok) return { ok: false, error: "This request changed while you were looking at it — refresh and try again." };
  await recordSignatureEvent(input.requestId, {
    type: "VOID",
    actorName: input.user.name,
    actorEmail: input.user.email,
    details: `Voided by ${input.user.name ?? input.user.email ?? "a team member"}${current.status === "awaiting_countersign" ? " after the customer had signed" : ""}. Reason: "${reason}"`,
  });
  if (current.status === "awaiting_countersign") {
    const { clearApprovalRequestNotifications } = await import("@/lib/notifications/commercial-events");
    await clearApprovalRequestNotifications(current.proposal_id, "commercial_proposal_signed");
  }
  return { ok: true };
}

export async function setSignatureDocuments(
  requestId: string,
  patch: { signed_document_id?: string; signed_sha256?: string; audit_document_id?: string }
): Promise<void> {
  const { error } = await commercialDb().from(REQUESTS).update(patch).eq("id", requestId);
  if (error) console.error(`[esign] couldn't link documents to request ${requestId}: ${error.message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────

export type SignatureReportRow = SignatureRequest & {
  proposal: ProposalForSigning | null;
  account_name: string | null;
};

/**
 * Every request whose link was sent inside an Eastern-time date window, newest
 * first, with its proposal and account — the Reports → Signatures table.
 *
 * The DB filter is widened by a day on each side and the exact cut is made on
 * the ET calendar date, so a link sent at 9pm ET on the last day of the window
 * isn't lost to UTC.
 */
export async function listSignatureRequestsForReport(range: { fromYmd: string; toYmd: string }): Promise<SignatureReportRow[]> {
  const sb = commercialDb();
  const widen = (ymd: string, days: number) => {
    const d = new Date(`${ymd}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString();
  };
  const { data } = await sb
    .from(REQUESTS)
    .select("*")
    .gte("created_at", widen(range.fromYmd, -1))
    .lt("created_at", widen(range.toYmd, 2))
    .order("created_at", { ascending: false })
    .limit(5000);
  const rows = ((data ?? []) as SignatureRequest[]).filter((r) => {
    const d = etDateOf(r.created_at);
    return !!d && d >= range.fromYmd && d <= range.toYmd;
  });
  return withProposalsAndAccounts(rows);
}

/** Every signature waiting on us, however old — the one report line that is
 *  somebody's job today, so no date window may hide it. */
export async function listAwaitingCountersign(): Promise<SignatureReportRow[]> {
  const { data } = await commercialDb()
    .from(REQUESTS)
    .select("*")
    .eq("status", "awaiting_countersign")
    .order("customer_signed_at", { ascending: true })
    .limit(500);
  return withProposalsAndAccounts((data ?? []) as SignatureRequest[]);
}

async function withProposalsAndAccounts(rows: SignatureRequest[]): Promise<SignatureReportRow[]> {
  if (rows.length === 0) return [];
  const sb = commercialDb();

  const proposalIds = Array.from(new Set(rows.map((r) => r.proposal_id)));
  const proposals = new Map<string, ProposalForSigning>();
  // One query per 200 ids, not one per proposal.
  for (let i = 0; i < proposalIds.length; i += 200) {
    const { data: batch } = await sb
      .from("commercial_proposals")
      .select(PROPOSAL_FOR_SIGNING_COLS)
      .in("id", proposalIds.slice(i, i + 200));
    for (const raw of (batch ?? []) as unknown[]) {
      const p = toProposalForSigning(raw);
      proposals.set(p.id, p);
    }
  }
  const accountIds = Array.from(new Set(Array.from(proposals.values()).map((p) => p.account_id).filter((x): x is string => !!x)));
  const accounts = new Map<string, string>();
  if (accountIds.length > 0) {
    const { data: acc } = await sb.from("commercial_accounts").select("id, company_name").in("id", accountIds);
    for (const a of (acc ?? []) as Array<{ id: string; company_name: string }>) accounts.set(a.id, a.company_name);
  }
  return rows.map((r) => {
    const p = proposals.get(r.proposal_id) ?? null;
    return { ...r, proposal: p, account_name: p?.account_id ? accounts.get(p.account_id) ?? null : null };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

async function transition(
  id: string,
  from: SignatureRequestStatus,
  to: SignatureRequestStatus,
  patch: Record<string, unknown>
): Promise<boolean> {
  const { data, error } = await commercialDb()
    .from(REQUESTS)
    .update({ ...patch, status: to })
    .eq("id", id)
    .eq("status", from)
    .select("id");
  if (error) {
    console.error(`[esign] ${from} → ${to} failed for ${id}: ${error.message}`);
    return false;
  }
  return (data ?? []).length > 0;
}

/**
 * Bytes of a filed document, INCLUDING one soft-deleted from the Files tab.
 *
 * A soft delete only hides the row — the file stays in Storage. Somebody
 * tidying a deal's documents must not silently break a GC's signing link or a
 * signed contract's download, so this deliberately does not use `getDocument`,
 * which filters deleted rows out.
 */
export async function downloadDocumentBytes(documentId: string): Promise<Buffer | null> {
  const { data } = await commercialDb()
    .from("commercial_documents")
    .select("storage_key")
    .eq("id", documentId)
    .maybeSingle();
  const key = (data as { storage_key: string } | null)?.storage_key ?? null;
  return downloadStorageBytes(key);
}

export async function downloadStorageBytes(key: string | null): Promise<Buffer | null> {
  if (!key) return null;
  try {
    const { data, error } = await commercialDb().storage.from(STORAGE_BUCKET).download(key);
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  } catch {
    return null;
  }
}
