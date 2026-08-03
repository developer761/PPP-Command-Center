import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert } from "@/lib/commercial/audit-log";
import { verifyFileMagicBytes } from "@/lib/commercial/accounts/documents";
import { UUID_RE } from "@/lib/commercial/uuid";
import { isValidDocumentCategory, type DocumentCategory } from "./categories";
import type { DocumentStatus } from "./status";
import {
  STORAGE_BUCKET,
  MAX_UPLOAD_BYTES,
  ALLOWED_MIME_TYPES,
  buildStorageKey,
  isValidParentType,
  type DocumentParentType,
  type CommercialDocument,
} from "./db";

/**
 * R6b — LARGE plan-set / bid-set uploads (up to 100 MB) for the Documents
 * system, uploaded DIRECTLY from the browser to Supabase Storage via a signed
 * upload URL.
 *
 * Why: Vercel serverless functions cap the request body at ~4.5 MB, so the
 * multipart POST path (documents/route.ts) physically cannot carry a 30 MB bid
 * set on production — it 413s at the platform edge before our code runs. (The
 * uploader already ADVERTISES "up to 100 MB", so this closes a real gap between
 * the promise and what actually worked in prod.) The bytes go straight to
 * Storage instead:
 *
 *   1. sign()     — server mints a one-time signed upload URL (auth + validation here).
 *   2. <browser>  — PUTs the file to Storage against that URL (bypasses Vercel; real % via XHR).
 *   3. finalize() — server confirms the object landed, sniffs its head for a
 *                   magic-byte match, and inserts the v1 metadata row (status 'draft').
 *
 * Small files keep using the multipart path — this only kicks in above a
 * threshold the client picks. The insert here mirrors uploadDocument() in
 * db.ts (first-version insert); keep the two in sync.
 */

/** Guard the parent (opportunity only until projects land in Phase H). */
async function assertParentLive(
  parentType: DocumentParentType,
  parentId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (parentType !== "opportunity") {
    return { ok: false, error: "Projects are not yet available (Phase H)." };
  }
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_opportunities")
    .select("id, deleted_at")
    .eq("id", parentId)
    .maybeSingle();
  if (!data || (data as { deleted_at?: string | null }).deleted_at) {
    return { ok: false, error: "Opportunity not found." };
  }
  return { ok: true };
}

/**
 * Read just the head bytes of an uploaded object + its total size WITHOUT
 * buffering the whole file. Streams the response and cancels after the first
 * chunk, so even a 100 MB object costs one small read. Range is requested but
 * the stream-cancel is the real guard (we don't depend on the server honoring it).
 */
async function sniffRemoteHead(
  signedUrl: string
): Promise<{ ok: true; head: Uint8Array; totalSize: number | null } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(signedUrl, {
      headers: { Range: "bytes=0-63" },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    return { ok: false, error: `Could not read the upload: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (res.status !== 200 && res.status !== 206) {
    return { ok: false, error: `Upload not found (HTTP ${res.status}). It may not have finished.` };
  }
  let totalSize: number | null = null;
  const cr = res.headers.get("content-range");
  const m = cr?.match(/\/(\d+)\s*$/);
  if (m) totalSize = Number(m[1]);
  else if (res.status === 200) {
    const cl = res.headers.get("content-length");
    if (cl) totalSize = Number(cl);
  }
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return { ok: true, head: buf.slice(0, 64), totalSize };
  }
  const reader = res.body.getReader();
  try {
    const { value } = await reader.read();
    await reader.cancel().catch(() => undefined);
    return { ok: true, head: value ? value.slice(0, 64) : new Uint8Array(0), totalSize };
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    return { ok: false, error: `Could not read the upload: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export type SignDocumentUploadInput = {
  parent_type: DocumentParentType;
  parent_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
};

/** Step 1 — mint a one-time signed upload URL for a new document. */
export async function signDocumentUpload(
  input: SignDocumentUploadInput
): Promise<
  | { ok: true; bucket: string; storage_key: string; token: string }
  | { ok: false; error: string }
> {
  if (!isValidParentType(input.parent_type)) return { ok: false, error: "Invalid parent." };
  if (!input.file_name?.trim()) return { ok: false, error: "Missing filename." };
  if (!Number.isFinite(input.size_bytes) || input.size_bytes <= 0) {
    return { ok: false, error: "Empty file." };
  }
  if (input.size_bytes > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `File too big (${Math.round(input.size_bytes / 1024 / 1024)} MB). Max ${Math.round(
        MAX_UPLOAD_BYTES / 1024 / 1024
      )} MB.`,
    };
  }
  if (!ALLOWED_MIME_TYPES.has(input.mime_type)) {
    return { ok: false, error: `File type not allowed: ${input.mime_type || "(unknown)"}.` };
  }

  const guard = await assertParentLive(input.parent_type, input.parent_id);
  if (!guard.ok) return guard;

  // Pre-allocate the document id so the storage key is deterministic and we can
  // re-derive it at finalize (the row id IS the leading key segment).
  const documentId = crypto.randomUUID();
  const storageKey = buildStorageKey(input.parent_type, input.parent_id, documentId, input.file_name);

  const sb = commercialDb();
  const { data, error } = await sb.storage.from(STORAGE_BUCKET).createSignedUploadUrl(storageKey);
  if (error || !data?.token) {
    return { ok: false, error: `Could not start upload: ${error?.message ?? "no token"}` };
  }
  return { ok: true, bucket: STORAGE_BUCKET, storage_key: storageKey, token: data.token };
}

export type FinalizeDocumentUploadInput = {
  parent_type: DocumentParentType;
  parent_id: string;
  category: DocumentCategory | string;
  storage_key: string;
  file_name: string;
  mime_type: string;
  notes?: string | null;
  uploaded_by_user_id: string;
};

/**
 * Step 3 — after the browser finishes the direct upload, confirm the object
 * exists, matches its declared type (magic-byte sniff on the head, without
 * downloading the whole file), is within the size ceiling, then insert the
 * v1 metadata row (status 'draft'). On any failure the orphaned object is
 * removed so the bucket stays consistent with the table.
 */
export async function finalizeDocumentUpload(
  input: FinalizeDocumentUploadInput
): Promise<{ ok: true; document: CommercialDocument } | { ok: false; error: string }> {
  const sb = commercialDb();
  const removeObject = () =>
    sb.storage.from(STORAGE_BUCKET).remove([input.storage_key]).catch(() => undefined);

  if (!isValidParentType(input.parent_type)) {
    await removeObject();
    return { ok: false, error: "Invalid parent." };
  }
  if (!input.file_name?.trim()) {
    await removeObject();
    return { ok: false, error: "Missing filename." };
  }
  if (!ALLOWED_MIME_TYPES.has(input.mime_type)) {
    await removeObject();
    return { ok: false, error: `File type not allowed: ${input.mime_type || "(unknown)"}.` };
  }
  const category = isValidDocumentCategory(input.category) ? input.category : "other";

  const guard = await assertParentLive(input.parent_type, input.parent_id);
  if (!guard.ok) {
    await removeObject();
    return guard;
  }

  // The storage key MUST belong to this parent, and its filename segment must
  // be the pre-allocated document id — stops a caller from pointing finalize at
  // another parent's object or forging an arbitrary row id.
  const expectedPrefix = `${input.parent_type}s/${input.parent_id}/`;
  if (!input.storage_key.startsWith(expectedPrefix)) {
    return { ok: false, error: "That upload doesn't belong to this deal." };
  }
  const leaf = input.storage_key.slice(expectedPrefix.length);
  const documentId = leaf.split("-", 5).join("-"); // uuid = first 5 dash-joined groups
  if (!UUID_RE.test(documentId)) {
    return { ok: false, error: "Malformed upload reference." };
  }

  // Confirm the object landed + sniff its head + read its true size.
  const { data: signed } = await sb.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(input.storage_key, 60);
  if (!signed?.signedUrl) {
    return { ok: false, error: "Upload not found — please try again." };
  }
  const head = await sniffRemoteHead(signed.signedUrl);
  if (!head.ok) {
    await removeObject();
    return head;
  }
  const magic = verifyFileMagicBytes(head.head, input.mime_type);
  if (!magic.ok) {
    await removeObject();
    return { ok: false, error: `File content doesn't match its type (${magic.detected}).` };
  }
  const size = head.totalSize;
  if (size !== null && size > MAX_UPLOAD_BYTES) {
    await removeObject();
    return { ok: false, error: `File too big (${Math.round(size / 1024 / 1024)} MB).` };
  }
  if (size !== null && size <= 0) {
    await removeObject();
    return { ok: false, error: "Empty file." };
  }

  const { data: row, error: insertErr } = await sb
    .from("commercial_documents")
    .insert({
      id: documentId,
      parent_type: input.parent_type,
      parent_id: input.parent_id,
      category,
      file_name: input.file_name.trim().slice(0, 255),
      notes: input.notes?.trim().slice(0, 500) || null,
      storage_key: input.storage_key,
      size_bytes: size ?? 0,
      mime_type: input.mime_type,
      version: 1,
      parent_document_id: null,
      status: "draft" as DocumentStatus,
      uploaded_by_user_id: input.uploaded_by_user_id,
    })
    .select("*")
    .single();
  if (insertErr) {
    await removeObject();
    return { ok: false, error: insertErr.message };
  }
  const doc = row as CommercialDocument;
  await logInsert("commercial_documents", doc.id, doc, input.uploaded_by_user_id);
  return { ok: true, document: doc };
}
