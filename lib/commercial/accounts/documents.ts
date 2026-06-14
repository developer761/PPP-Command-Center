import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate } from "@/lib/commercial/audit-log";

/**
 * Commercial Account documents — metadata in Postgres, files in Supabase
 * Storage bucket `commercial-account-docs`.
 *
 * Storage path convention: `accounts/{account_id}/{document_id}-{file_name}`.
 * Filename is sanitized before insert (spaces/special chars → safe form) so
 * the storage key is predictable.
 *
 * Versioning: re-uploading the same category for an account ARCHIVES the prior
 * row (sets archived=TRUE + archived_at + archived_by_user_id) and inserts a
 * fresh row with version = prior.version + 1. The Documents tab shows the
 * active row prominently with the version history collapsed below.
 *
 * Expiry: COI / insurance docs use `expires_at`. The UI renders a red
 * "Expires in N days" badge when within 30 days and "Expired N days ago"
 * when past. No cron yet — that's a follow-up.
 */

export const DOCUMENT_CATEGORIES = [
  "coi",
  "w9",
  "master_agreement",
  "vendor_onboarding",
  "safety",
  "other",
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export function documentCategoryLabel(c: DocumentCategory): string {
  return {
    coi: "Certificate of Insurance (COI)",
    w9: "W-9",
    master_agreement: "Master Service Agreement",
    vendor_onboarding: "Vendor Onboarding / Prequal",
    safety: "Safety / OSHA",
    other: "Other",
  }[c];
}

export type CommercialAccountDocument = {
  id: string;
  account_id: string;
  category: DocumentCategory;
  file_name: string;
  storage_key: string;
  version: number;
  size_bytes: number | null;
  mime_type: string | null;
  uploaded_by_user_id: string | null;
  uploaded_at: string;
  expires_at: string | null;
  archived: boolean;
  archived_at: string | null;
  archived_by_user_id: string | null;
  notes: string | null;
};

export const STORAGE_BUCKET = "commercial-account-docs";

/** 50 MB cap. Anything bigger and we make them split / chat with IT. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Allowed MIME types — keep in sync with the bucket settings in Supabase. */
export const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

/** Strip path-unsafe chars from a filename, collapse spaces, lowercase. */
export function sanitizeFileName(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? name;
  return (
    base
      .toLowerCase()
      // remove anything that isn't alphanumeric, period, dash, or underscore
      .replace(/[^a-z0-9._-]+/g, "-")
      // collapse multiple dashes
      .replace(/-+/g, "-")
      // trim leading / trailing dashes
      .replace(/^-+|-+$/g, "")
      .slice(0, 200) || "untitled"
  );
}

/** Build the storage path for a new document. */
export function buildStorageKey(accountId: string, documentId: string, fileName: string): string {
  return `accounts/${accountId}/${documentId}-${sanitizeFileName(fileName)}`;
}

/**
 * List documents for an account, grouped by category. Active row (highest
 * version, not archived) is `active`; older versions stack in `history`.
 */
export async function listAccountDocuments(accountId: string): Promise<
  Array<{
    category: DocumentCategory;
    active: CommercialAccountDocument | null;
    history: CommercialAccountDocument[];
  }>
> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_account_documents")
    .select("*")
    .eq("account_id", accountId)
    .order("uploaded_at", { ascending: false });

  if (error) {
    console.warn("[commercial/documents] list failed:", error.message);
    return DOCUMENT_CATEGORIES.map((c) => ({ category: c, active: null, history: [] }));
  }

  const rows = (data ?? []) as CommercialAccountDocument[];
  const out = DOCUMENT_CATEGORIES.map((category) => {
    const inCat = rows.filter((r) => r.category === category);
    const active = inCat.find((r) => !r.archived) ?? null;
    const history = inCat.filter((r) => r.archived);
    return { category, active, history };
  });
  return out;
}

export type UploadDocumentInput = {
  account_id: string;
  category: DocumentCategory;
  file_name: string;
  size_bytes: number;
  mime_type: string;
  expires_at?: string | null;
  notes?: string | null;
  /** Raw file payload (Buffer or Uint8Array). */
  data: Uint8Array;
  uploaded_by_user_id: string;
};

/**
 * Upload a document. Validates size + MIME, archives any prior active doc
 * in the same category, uploads to Storage, then inserts the metadata row.
 *
 * On Storage upload failure we DO NOT insert a metadata row — keeps the
 * table consistent with what's actually in the bucket.
 */
export async function uploadDocument(
  input: UploadDocumentInput
): Promise<{ ok: true; document: CommercialAccountDocument } | { ok: false; error: string }> {
  if (!input.file_name?.trim()) return { ok: false, error: "Missing filename." };
  if (input.size_bytes <= 0) return { ok: false, error: "Empty file." };
  if (input.size_bytes > MAX_UPLOAD_BYTES) {
    return { ok: false, error: `File too big (${Math.round(input.size_bytes / 1024 / 1024)} MB). Max 50 MB.` };
  }
  if (!ALLOWED_MIME_TYPES.has(input.mime_type)) {
    return { ok: false, error: `File type not allowed: ${input.mime_type}.` };
  }

  const sb = commercialDb();

  // Look up the current active row in this category — we'll archive it
  // AFTER the storage + insert succeed so a partial upload doesn't strand
  // the account without an active doc.
  const { data: prior } = await sb
    .from("commercial_account_documents")
    .select("*")
    .eq("account_id", input.account_id)
    .eq("category", input.category)
    .eq("archived", false)
    .maybeSingle();

  const priorRow = prior as CommercialAccountDocument | null;
  const nextVersion = (priorRow?.version ?? 0) + 1;

  // Generate the new document id up-front so we can build the storage key.
  // crypto.randomUUID is available in the Node serverless runtime.
  const documentId = globalThis.crypto.randomUUID();
  const storageKey = buildStorageKey(input.account_id, documentId, input.file_name);

  // Upload to storage. Bucket must exist + be private — see the Storage
  // setup instructions in the migration README. We surface the storage
  // error verbatim because it's usually descriptive ("bucket not found",
  // "row level security violation", etc.).
  const upload = await sb.storage.from(STORAGE_BUCKET).upload(storageKey, input.data, {
    contentType: input.mime_type,
    upsert: false,
  });
  if (upload.error) {
    return { ok: false, error: `Storage upload failed: ${upload.error.message}` };
  }

  // Insert the metadata row. If this fails, try to clean up the storage
  // upload so we don't leak orphan files.
  const { data: inserted, error: insertErr } = await sb
    .from("commercial_account_documents")
    .insert({
      id: documentId,
      account_id: input.account_id,
      category: input.category,
      file_name: input.file_name.trim(),
      storage_key: storageKey,
      version: nextVersion,
      size_bytes: input.size_bytes,
      mime_type: input.mime_type,
      uploaded_by_user_id: input.uploaded_by_user_id,
      expires_at: input.expires_at ?? null,
      notes: input.notes?.trim() || null,
    })
    .select("*")
    .single();

  if (insertErr) {
    // Best-effort cleanup. Don't bubble the cleanup error to the caller.
    await sb.storage.from(STORAGE_BUCKET).remove([storageKey]).catch(() => undefined);
    return { ok: false, error: insertErr.message };
  }

  const newDoc = inserted as CommercialAccountDocument;
  await logInsert("commercial_account_documents", newDoc.id, newDoc, input.uploaded_by_user_id);

  // Archive the prior active doc (if any). We do this AFTER the new row
  // is solid so the account always has at least one active doc in this
  // category if one already existed.
  if (priorRow) {
    const archivedAt = new Date().toISOString();
    const { data: archived } = await sb
      .from("commercial_account_documents")
      .update({
        archived: true,
        archived_at: archivedAt,
        archived_by_user_id: input.uploaded_by_user_id,
      })
      .eq("id", priorRow.id)
      .select("*")
      .single();
    if (archived) {
      await logUpdate(
        "commercial_account_documents",
        priorRow.id,
        priorRow,
        archived,
        input.uploaded_by_user_id
      );
    }
  }

  return { ok: true, document: newDoc };
}

/**
 * Archive an active document without uploading a replacement. Sets
 * `archived = TRUE` + audit fields. Storage object stays so the history
 * tab can still download it.
 */
export async function archiveDocument(
  documentId: string,
  archivedByUserId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_account_documents")
    .select("*")
    .eq("id", documentId)
    .maybeSingle();
  if (!before) return { ok: false, error: "Document not found." };
  const beforeRow = before as CommercialAccountDocument;
  if (beforeRow.archived) return { ok: false, error: "Already archived." };

  const { data: after, error } = await sb
    .from("commercial_account_documents")
    .update({
      archived: true,
      archived_at: new Date().toISOString(),
      archived_by_user_id: archivedByUserId,
    })
    .eq("id", documentId)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };

  await logUpdate("commercial_account_documents", documentId, before, after, archivedByUserId);
  return { ok: true };
}

/**
 * Generate a short-lived signed URL for downloading a document. 5-minute
 * TTL keeps shared links from leaking long-term. Returns null on failure.
 */
export async function getDocumentSignedUrl(
  storageKey: string,
  ttlSeconds: number = 5 * 60
): Promise<string | null> {
  const sb = commercialDb();
  const { data, error } = await sb.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(storageKey, ttlSeconds);
  if (error) {
    console.warn("[commercial/documents] signed url failed:", error.message);
    return null;
  }
  return data?.signedUrl ?? null;
}

/**
 * Expiry classification — drives the UI badge color.
 *   "expired" → past expires_at
 *   "soon"    → within 30 days
 *   "ok"      → > 30 days out OR no expiry set
 */
export type ExpiryStatus = "ok" | "soon" | "expired";

export function expiryStatus(expiresAt: string | null): {
  status: ExpiryStatus;
  daysUntil: number | null;
} {
  if (!expiresAt) return { status: "ok", daysUntil: null };
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(ms)) return { status: "ok", daysUntil: null };
  const days = Math.ceil(ms / 86_400_000);
  if (days < 0) return { status: "expired", daysUntil: days };
  if (days <= 30) return { status: "soon", daysUntil: days };
  return { status: "ok", daysUntil: days };
}
