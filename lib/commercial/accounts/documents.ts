import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate } from "@/lib/commercial/audit-log";
import { MS_PER_DAY, EXPIRY_WARNING_DAYS } from "./constants";

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

/**
 * Verify the file's actual binary content matches the MIME type the
 * browser reported. Prevents the "renamed malware.exe to invoice.pdf"
 * trick — the browser-reported MIME type is user-spoofable, but the
 * first few bytes of the file (the "magic number") are not.
 *
 * Returns { ok: true } if content matches the declared type, or
 * { ok: false, detected } with what we sniffed instead.
 *
 * Word/Excel detection is intentionally loose: docx/xlsx are ZIP
 * containers (PK\x03\x04), and old .doc/.xls are OLE compound files
 * (D0 CF 11 E0). We accept either prefix for any office-mime — better
 * a false-positive accept on a legitimate file than a false-positive
 * reject on a customer's W-9.
 */
export function verifyFileMagicBytes(
  buffer: Uint8Array,
  declaredMime: string
): { ok: true } | { ok: false; detected: string } {
  // Need at least the first 12 bytes for the most common signatures.
  if (buffer.length < 4) {
    return { ok: false, detected: "file too short to verify" };
  }
  const b = buffer;
  const startsWith = (sig: number[]) => sig.every((byte, i) => b[i] === byte);
  const matchesAt = (offset: number, sig: number[]) =>
    sig.every((byte, i) => b[offset + i] === byte);

  // PDF — "%PDF" (25 50 44 46)
  if (startsWith([0x25, 0x50, 0x44, 0x46])) {
    return declaredMime === "application/pdf"
      ? { ok: true }
      : { ok: false, detected: "PDF" };
  }
  // PNG — 89 50 4E 47
  if (startsWith([0x89, 0x50, 0x4e, 0x47])) {
    return declaredMime === "image/png" ? { ok: true } : { ok: false, detected: "PNG" };
  }
  // JPEG — FF D8 FF
  if (startsWith([0xff, 0xd8, 0xff])) {
    return declaredMime === "image/jpeg" || declaredMime === "image/jpg"
      ? { ok: true }
      : { ok: false, detected: "JPEG" };
  }
  // WEBP — "RIFF" ... "WEBP" at offset 8
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && b.length >= 12 && matchesAt(8, [0x57, 0x45, 0x42, 0x50])) {
    return declaredMime === "image/webp" ? { ok: true } : { ok: false, detected: "WEBP" };
  }
  // HEIC / HEIF — "ftyp" at offset 4, then "heic" / "heif" / "mif1" / "msf1" at offset 8
  if (b.length >= 12 && matchesAt(4, [0x66, 0x74, 0x79, 0x70])) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (["heic", "heix", "heif", "mif1", "msf1"].includes(brand)) {
      return declaredMime === "image/heic" || declaredMime === "image/heif"
        ? { ok: true }
        : { ok: false, detected: "HEIC/HEIF" };
    }
  }
  // GIF — "GIF87a" / "GIF89a"
  if (startsWith([0x47, 0x49, 0x46, 0x38])) {
    return { ok: false, detected: "GIF (not in allowlist)" };
  }
  // ZIP-based Office (docx, xlsx, pptx) — PK\x03\x04
  if (startsWith([0x50, 0x4b, 0x03, 0x04])) {
    const officeZipMimes = new Set([
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ]);
    return officeZipMimes.has(declaredMime)
      ? { ok: true }
      : { ok: false, detected: "ZIP-based (docx/xlsx)" };
  }
  // Legacy Office OLE compound (.doc, .xls) — D0 CF 11 E0 A1 B1 1A E1
  if (startsWith([0xd0, 0xcf, 0x11, 0xe0])) {
    const oleMimes = new Set([
      "application/msword",
      "application/vnd.ms-excel",
    ]);
    return oleMimes.has(declaredMime)
      ? { ok: true }
      : { ok: false, detected: "Legacy Office (doc/xls)" };
  }
  // Executable signatures — explicit reject. We DON'T accept these even
  // if the user declares some random MIME, because there's no path that
  // should let an exe / Mach-O / ELF into commercial-account-docs.
  if (startsWith([0x4d, 0x5a])) {
    return { ok: false, detected: "Windows executable (.exe / .dll)" };
  }
  if (startsWith([0x7f, 0x45, 0x4c, 0x46])) {
    return { ok: false, detected: "Linux executable (ELF)" };
  }
  if (startsWith([0xcf, 0xfa, 0xed, 0xfe]) || startsWith([0xfe, 0xed, 0xfa, 0xce])) {
    return { ok: false, detected: "macOS executable (Mach-O)" };
  }
  // Unknown signature — fail closed. If a legitimate format isn't
  // covered, add it to the allowlist explicitly above.
  return { ok: false, detected: `unknown (first 4 bytes: ${Array.from(b.slice(0, 4)).map((x) => x.toString(16).padStart(2, "0")).join(" ")})` };
}

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

  // Defense in depth: even though the POST API route already gates this,
  // the lib helper must refuse uploads to a missing or soft-deleted
  // account so callers (now or future) can't bypass the check.
  const { data: account } = await sb
    .from("commercial_accounts")
    .select("id, deleted_at")
    .eq("id", input.account_id)
    .maybeSingle();
  if (!account || account.deleted_at) {
    return { ok: false, error: "Account not found." };
  }

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

  // Archive the prior active doc FIRST so the partial unique index
  // (migration 023: at most one non-archived row per (account, category))
  // doesn't block our insert. Audit 2026-06-14: previously we inserted
  // first and archived after — that worked for sequential uploads but a
  // concurrent second upload would race for the same prior row and end
  // up with two non-archived rows for the same category. Doing it in
  // this order means: a concurrent second upload sees prior already
  // archived → still inserts → both succeed cleanly with distinct
  // version numbers and the index never fires.
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
      .eq("archived", false) // race guard — only archive if still active
      .select("*")
      .maybeSingle();
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

  // Annual-renewal default (Stage 3): when expires_at is OMITTED
  // (property is undefined) on a renewable compliance doc, default
  // to 1 year from upload so the Stage 1 expiring-documents cron
  // catches it naturally. Without this, docs without expires_at
  // would never alert. Explicit `null` is RESPECTED so admin can
  // upload a renewable doc with deliberately-no-expiry (e.g. legacy
  // archival) by sending null instead of omitting the field. Audit
  // fix 2026-06-18: previously even an explicit null got overridden
  // with the default, locking admin out of "no expiry" semantics.
  // Renewable categories: COI (yearly renewal) + W-9 (annual refresh)
  // + master_agreement (often annual).
  const RENEWABLE_CATEGORIES = new Set(["coi", "w9", "master_agreement"]);
  const computedExpiresAt =
    input.expires_at !== undefined
      ? input.expires_at
      : RENEWABLE_CATEGORIES.has(input.category)
        ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
        : null;

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
      expires_at: computedExpiresAt,
      notes: input.notes?.trim() || null,
    })
    .select("*")
    .single();

  if (insertErr) {
    // Best-effort cleanup. Don't bubble the cleanup error to the caller.
    await sb.storage.from(STORAGE_BUCKET).remove([storageKey]).catch(() => undefined);
    // The partial unique index would fire if another concurrent upload
    // raced ahead — surface a friendly message instead of a raw constraint
    // name.
    if (insertErr.message?.toLowerCase().includes("commercial_account_documents_one_active")) {
      return {
        ok: false,
        error: "Someone else uploaded the same category at the same time — refresh and try again.",
      };
    }
    return { ok: false, error: insertErr.message };
  }

  const newDoc = inserted as CommercialAccountDocument;
  await logInsert("commercial_account_documents", newDoc.id, newDoc, input.uploaded_by_user_id);

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
 * Restore an archived version as the new active version. Copies the storage
 * file to a fresh path (so the original archived row still resolves), then
 * archives the current active row + inserts a new row at version = max+1
 * pointing at the new storage key.
 *
 * Why copy the file instead of reusing the storage key: future hard-delete
 * of either row would break the other. The storage copy is an O(1) server-
 * side operation (Supabase Storage `.copy()` — no re-download).
 *
 * Returns the new active document on success.
 */
export async function restoreDocument(
  archivedDocumentId: string,
  restoredByUserId: string
): Promise<{ ok: true; document: CommercialAccountDocument } | { ok: false; error: string }> {
  const sb = commercialDb();

  // Load the archived doc we're restoring from.
  const { data: src } = await sb
    .from("commercial_account_documents")
    .select("*")
    .eq("id", archivedDocumentId)
    .maybeSingle();
  if (!src) return { ok: false, error: "Document not found." };
  const srcRow = src as CommercialAccountDocument;
  if (!srcRow.archived) {
    return { ok: false, error: "This version is already active." };
  }

  // Find the current active so we can archive it (if any). Also use it to
  // compute next version.
  const { data: active } = await sb
    .from("commercial_account_documents")
    .select("*")
    .eq("account_id", srcRow.account_id)
    .eq("category", srcRow.category)
    .eq("archived", false)
    .maybeSingle();
  const activeRow = active as CommercialAccountDocument | null;

  // Compute next version — max across ALL rows in this category (active +
  // archived), so a restored copy lands above every prior version.
  const { data: allInCat } = await sb
    .from("commercial_account_documents")
    .select("version")
    .eq("account_id", srcRow.account_id)
    .eq("category", srcRow.category)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const maxVersion = (allInCat as { version: number } | null)?.version ?? srcRow.version;
  const nextVersion = maxVersion + 1;

  // Generate new id + storage key + copy the blob.
  const newDocumentId = globalThis.crypto.randomUUID();
  const newStorageKey = buildStorageKey(srcRow.account_id, newDocumentId, srcRow.file_name);
  const copyResult = await sb.storage
    .from(STORAGE_BUCKET)
    .copy(srcRow.storage_key, newStorageKey);
  if (copyResult.error) {
    return { ok: false, error: `Storage copy failed: ${copyResult.error.message}` };
  }

  // Archive the current active (if any), guarded by archived=false to keep
  // concurrent restore attempts race-safe — same pattern as uploadDocument.
  if (activeRow) {
    const archivedAt = new Date().toISOString();
    await sb
      .from("commercial_account_documents")
      .update({
        archived: true,
        archived_at: archivedAt,
        archived_by_user_id: restoredByUserId,
      })
      .eq("id", activeRow.id)
      .eq("archived", false);
  }

  // Insert new active row pointing at the copied blob.
  const { data: inserted, error: insertErr } = await sb
    .from("commercial_account_documents")
    .insert({
      id: newDocumentId,
      account_id: srcRow.account_id,
      category: srcRow.category,
      file_name: srcRow.file_name,
      storage_key: newStorageKey,
      version: nextVersion,
      size_bytes: srcRow.size_bytes,
      mime_type: srcRow.mime_type,
      uploaded_by_user_id: restoredByUserId,
      expires_at: srcRow.expires_at,
      notes: `Restored from v${srcRow.version} (uploaded ${srcRow.uploaded_at.slice(0, 10)})${srcRow.notes ? ` · ${srcRow.notes}` : ""}`,
    })
    .select("*")
    .single();

  if (insertErr) {
    // Best-effort cleanup of the copied blob.
    await sb.storage.from(STORAGE_BUCKET).remove([newStorageKey]).catch(() => undefined);
    return { ok: false, error: insertErr.message };
  }
  const newDoc = inserted as CommercialAccountDocument;
  await logInsert("commercial_account_documents", newDoc.id, newDoc, restoredByUserId);
  return { ok: true, document: newDoc };
}

/**
 * Like listAccountDocuments but resolves the uploaded_by + archived_by
 * user IDs to display names (via the profiles table) for the audit-trail
 * UI. One extra query — keeps the base listAccountDocuments lean for
 * callers that don't need names.
 */
export async function listAccountDocumentsWithUploaders(accountId: string): Promise<
  Array<{
    category: DocumentCategory;
    active: (CommercialAccountDocument & { uploader_name: string | null; archiver_name: string | null }) | null;
    history: Array<CommercialAccountDocument & { uploader_name: string | null; archiver_name: string | null }>;
  }>
> {
  const groups = await listAccountDocuments(accountId);
  // Collect every user id we need to resolve in one round-trip.
  const userIds = new Set<string>();
  for (const g of groups) {
    if (g.active?.uploaded_by_user_id) userIds.add(g.active.uploaded_by_user_id);
    if (g.active?.archived_by_user_id) userIds.add(g.active.archived_by_user_id);
    for (const h of g.history) {
      if (h.uploaded_by_user_id) userIds.add(h.uploaded_by_user_id);
      if (h.archived_by_user_id) userIds.add(h.archived_by_user_id);
    }
  }
  const nameMap = new Map<string, string>();
  if (userIds.size > 0) {
    const sb = commercialDb();
    const { data: profiles } = await sb
      .from("profiles")
      .select("user_id, sf_user_name, email")
      .in("user_id", Array.from(userIds));
    for (const p of (profiles ?? []) as Array<{ user_id: string; sf_user_name: string | null; email: string | null }>) {
      // Prefer human name; fall back to email local-part.
      const name = p.sf_user_name?.trim() || (p.email?.split("@")[0] ?? null);
      if (name) nameMap.set(p.user_id, name);
    }
  }
  const enrich = <T extends CommercialAccountDocument>(d: T) => ({
    ...d,
    uploader_name: d.uploaded_by_user_id ? (nameMap.get(d.uploaded_by_user_id) ?? null) : null,
    archiver_name: d.archived_by_user_id ? (nameMap.get(d.archived_by_user_id) ?? null) : null,
  });
  return groups.map((g) => ({
    category: g.category,
    active: g.active ? enrich(g.active) : null,
    history: g.history.map(enrich),
  }));
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
  const days = Math.ceil(ms / MS_PER_DAY);
  if (days < 0) return { status: "expired", daysUntil: days };
  if (days <= EXPIRY_WARNING_DAYS) return { status: "soon", daysUntil: days };
  return { status: "ok", daysUntil: days };
}

/**
 * Per-category compliance check. Drives the "Compliance" checklist
 * card on the Info tab — at-a-glance "what's missing, what's about to
 * expire, what's good." Categories with no required expiry (W-9, MSA,
 * Vendor App, Safety, Other) are "ok" if any active doc exists; the
 * expiry pill only kicks in when expires_at is populated.
 *
 * `health` semantics:
 *   missing — no active doc in this category
 *   expired — active doc has expires_at in the past
 *   soon    — active doc expires within 30 days
 *   ok      — active doc, no expiry concern
 */
export type ComplianceHealth = "missing" | "expired" | "soon" | "ok";

export type ComplianceItem = {
  category: DocumentCategory;
  label: string;
  health: ComplianceHealth;
  active_document_id: string | null;
  expires_at: string | null;
  days_until: number | null;
};

/** Required categories for "compliant" state. `other` is excluded —
 *  it's a catch-all bucket, not a compliance gate. */
export const REQUIRED_DOCUMENT_CATEGORIES: ReadonlyArray<DocumentCategory> = [
  "coi",
  "w9",
  "master_agreement",
  "vendor_onboarding",
  "safety",
];

export function buildComplianceChecklist(
  groups: Array<{
    category: DocumentCategory;
    active: CommercialAccountDocument | null;
    history: CommercialAccountDocument[];
  }>
): ComplianceItem[] {
  return REQUIRED_DOCUMENT_CATEGORIES.map((category) => {
    const group = groups.find((g) => g.category === category);
    const active = group?.active ?? null;
    if (!active) {
      return {
        category,
        label: documentCategoryLabel(category),
        health: "missing" as ComplianceHealth,
        active_document_id: null,
        expires_at: null,
        days_until: null,
      };
    }
    const exp = expiryStatus(active.expires_at);
    const health: ComplianceHealth =
      exp.status === "expired" ? "expired" : exp.status === "soon" ? "soon" : "ok";
    return {
      category,
      label: documentCategoryLabel(category),
      health,
      active_document_id: active.id,
      expires_at: active.expires_at,
      days_until: exp.daysUntil,
    };
  });
}
