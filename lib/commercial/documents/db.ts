import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";
import {
  verifyFileMagicBytes,
  sanitizeFileName,
} from "@/lib/commercial/accounts/documents";
import type { DocumentCategory } from "./categories";
import { isValidDocumentCategory } from "./categories";
import type { DocumentStatus } from "./status";
import { canTransitionDocumentStatus, isTerminalDocumentStatus } from "./status";

/**
 * Phase C · Documents — DB layer (server-only).
 *
 * Polymorphic parent: parent_type ∈ ('opportunity', 'project'), parent_id UUID.
 * Storage bucket: `commercial-documents`.
 * Storage key convention: `{parent_type}s/{parent_id}/{document_id}-{sanitized_file_name}`.
 *
 * Version chain: linked list via parent_document_id. New upload replaces
 * the head — the old head auto-transitions to 'superseded' (terminal).
 * Users can walk backwards through the chain for history.
 *
 * Favorites: soft cap of 5 per (parent, category). Enforced at the app
 * layer for a friendly "unfavorite one first" prompt instead of a hard
 * DB reject.
 */

export type DocumentParentType = "opportunity" | "project";

export function isValidParentType(t: string): t is DocumentParentType {
  return t === "opportunity" || t === "project";
}

export type CommercialDocument = {
  id: string;
  parent_type: DocumentParentType;
  parent_id: string;
  category: DocumentCategory | string;
  file_name: string;
  notes: string | null;
  storage_key: string;
  size_bytes: number;
  mime_type: string;
  version: number;
  parent_document_id: string | null;
  status: DocumentStatus;
  favorited_at: string | null;
  uploaded_by_user_id: string | null;
  uploaded_at: string;
  deleted_at: string | null;
  deleted_by_user_id: string | null;
  created_at: string;
  updated_at: string;
};

export const STORAGE_BUCKET = "commercial-documents";

/** 100 MB cap — bid sets get big. Matches the Supabase bucket setting. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Favorites cap per (parent, category). Soft rule — app-layer enforced. */
export const MAX_FAVORITES_PER_CATEGORY = 5;

/** MIME allowlist. Broader than account-docs — plans + photos + sheets. */
export const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
]);

/** Build the storage path for a new document. */
export function buildStorageKey(
  parentType: DocumentParentType,
  parentId: string,
  documentId: string,
  fileName: string
): string {
  return `${parentType}s/${parentId}/${documentId}-${sanitizeFileName(fileName)}`;
}

// ═══════════════════════════════════════════════════════════════════
// Parent-existence check — the lib refuses to operate on parents that
// don't exist or are soft-deleted, so callers can't sneak an orphan
// document through.
// ═══════════════════════════════════════════════════════════════════

async function assertParentLive(
  parentType: DocumentParentType,
  parentId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  if (parentType === "opportunity") {
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
  // parent_type === "project" — table doesn't exist until Phase H.
  // Refuse cleanly so we don't crash if someone hand-crafts a request
  // before the projects table is live.
  return { ok: false, error: "Projects are not yet available (Phase H)." };
}

// ═══════════════════════════════════════════════════════════════════
// Reads
// ═══════════════════════════════════════════════════════════════════

/**
 * List all live documents for a parent, newest first. Includes drafts,
 * pending, approved, rejected — even superseded (so the UI can render
 * "Superseded — see current version").
 */
export async function listDocumentsForParent(
  parentType: DocumentParentType,
  parentId: string
): Promise<CommercialDocument[]> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_documents")
    .select("*")
    .eq("parent_type", parentType)
    .eq("parent_id", parentId)
    .is("deleted_at", null)
    .order("uploaded_at", { ascending: false });
  if (error) {
    console.warn("[commercial/documents] list failed:", error.message);
    return [];
  }
  return (data ?? []) as CommercialDocument[];
}

/** Get one document by id (soft-delete aware). */
export async function getDocument(id: string): Promise<CommercialDocument | null> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_documents")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  return (data as CommercialDocument | null) ?? null;
}

/**
 * Walk the version chain backwards for a document — returns the chain
 * from newest → oldest (excluding the doc itself). Used by the
 * "See older versions" UI affordance.
 */
export async function listDocumentVersionChain(
  documentId: string
): Promise<CommercialDocument[]> {
  const sb = commercialDb();
  const chain: CommercialDocument[] = [];
  let cursor: string | null = documentId;
  // Cap at 50 hops so a pathological cycle (shouldn't happen — FK is
  // ON DELETE SET NULL, not cascade) can't infinite-loop this query.
  // Filters soft-deleted docs so the "See older versions" UI doesn't
  // surface tombstones (audit fix 2026-07-10).
  for (let i = 0; i < 50 && cursor; i++) {
    const { data }: { data: CommercialDocument | null } = await sb
      .from("commercial_documents")
      .select("*")
      .eq("id", cursor)
      .is("deleted_at", null)
      .maybeSingle();
    if (!data) break;
    if (i > 0) chain.push(data); // skip the head itself
    cursor = data.parent_document_id;
  }
  return chain;
}

// ═══════════════════════════════════════════════════════════════════
// Upload — the entry point for a brand-new document (first version).
// ═══════════════════════════════════════════════════════════════════

export type UploadDocumentInput = {
  parent_type: DocumentParentType;
  parent_id: string;
  category: DocumentCategory | string;
  file_name: string;
  size_bytes: number;
  mime_type: string;
  notes?: string | null;
  data: Uint8Array;
  uploaded_by_user_id: string;
};

export async function uploadDocument(
  input: UploadDocumentInput
): Promise<{ ok: true; document: CommercialDocument } | { ok: false; error: string }> {
  if (!input.file_name?.trim()) return { ok: false, error: "Missing filename." };
  if (input.size_bytes <= 0) return { ok: false, error: "Empty file." };
  if (input.size_bytes > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `File too big (${Math.round(input.size_bytes / 1024 / 1024)} MB). Max 100 MB.`,
    };
  }
  if (!ALLOWED_MIME_TYPES.has(input.mime_type)) {
    return { ok: false, error: `File type not allowed: ${input.mime_type}.` };
  }
  const magic = verifyFileMagicBytes(input.data, input.mime_type);
  if (!magic.ok) {
    return { ok: false, error: `File content doesn't match its type (${magic.detected}).` };
  }
  const category = isValidDocumentCategory(input.category) ? input.category : "other";

  const parentCheck = await assertParentLive(input.parent_type, input.parent_id);
  if (!parentCheck.ok) return parentCheck;

  const sb = commercialDb();
  const documentId = crypto.randomUUID();
  const storageKey = buildStorageKey(
    input.parent_type,
    input.parent_id,
    documentId,
    input.file_name
  );

  // Upload to Storage FIRST. If Storage fails, we skip the metadata row
  // so the DB stays consistent with what's actually in the bucket.
  const { error: storageErr } = await sb.storage
    .from(STORAGE_BUCKET)
    .upload(storageKey, input.data, {
      contentType: input.mime_type,
      upsert: false,
    });
  if (storageErr) {
    return { ok: false, error: `Upload failed: ${storageErr.message}` };
  }

  const { data: row, error: insertErr } = await sb
    .from("commercial_documents")
    .insert({
      id: documentId,
      parent_type: input.parent_type,
      parent_id: input.parent_id,
      category,
      file_name: input.file_name.trim().slice(0, 255),
      notes: input.notes?.trim() || null,
      storage_key: storageKey,
      size_bytes: input.size_bytes,
      mime_type: input.mime_type,
      version: 1,
      parent_document_id: null,
      status: "draft" as DocumentStatus,
      uploaded_by_user_id: input.uploaded_by_user_id,
    })
    .select("*")
    .single();
  if (insertErr) {
    // Best-effort cleanup: try to remove the orphaned file from Storage.
    await sb.storage.from(STORAGE_BUCKET).remove([storageKey]).catch(() => {});
    return { ok: false, error: insertErr.message };
  }
  const doc = row as CommercialDocument;
  await logInsert("commercial_documents", doc.id, doc, input.uploaded_by_user_id);
  return { ok: true, document: doc };
}

// ═══════════════════════════════════════════════════════════════════
// Version bump — upload a new version of an existing document. The old
// version auto-transitions to 'superseded' (terminal — the only path
// to that status).
// ═══════════════════════════════════════════════════════════════════

export type BumpVersionInput = {
  previous_document_id: string;
  file_name: string;
  size_bytes: number;
  mime_type: string;
  notes?: string | null;
  data: Uint8Array;
  uploaded_by_user_id: string;
};

export async function bumpDocumentVersion(
  input: BumpVersionInput
): Promise<{ ok: true; document: CommercialDocument } | { ok: false; error: string }> {
  const prev = await getDocument(input.previous_document_id);
  if (!prev) return { ok: false, error: "Previous version not found." };
  if (prev.status === "superseded") {
    return { ok: false, error: "That version is already superseded — bump the current head instead." };
  }

  // The new version inherits parent_type + parent_id + category from the
  // previous version — those don't change across a version bump.
  const uploaded = await uploadDocument({
    parent_type: prev.parent_type,
    parent_id: prev.parent_id,
    category: prev.category,
    file_name: input.file_name,
    size_bytes: input.size_bytes,
    mime_type: input.mime_type,
    notes: input.notes,
    data: input.data,
    uploaded_by_user_id: input.uploaded_by_user_id,
  });
  if (!uploaded.ok) return uploaded;

  // Now wire the new row into the chain and demote the old row to
  // superseded. Do this as two sequential updates; a chain break is
  // recoverable (both rows still exist + point at their storage keys)
  // whereas a rollback would leave the file uploaded but orphaned.
  const sb = commercialDb();
  const newDocId = uploaded.document.id;
  const newVersion = prev.version + 1;

  const { data: chained, error: chainErr } = await sb
    .from("commercial_documents")
    .update({
      parent_document_id: prev.id,
      version: newVersion,
    })
    .eq("id", newDocId)
    .select("*")
    .single();
  if (chainErr) {
    // Migration 048 partial UNIQUE (idx_commercial_documents_one_child_
    // per_parent) rejects a second concurrent version bump on the same
    // prev doc. Postgres returns SQLSTATE 23505 → the wrapper surfaces
    // as "duplicate key value violates unique constraint". Present a
    // friendly refresh prompt + best-effort clean up the orphan row we
    // just uploaded (Storage cleanup lives in uploadDocument's error
    // path; here we soft-delete the metadata row so the list doesn't
    // show a headless clone).
    const isRace =
      chainErr.code === "23505" ||
      /unique constraint|duplicate key/i.test(chainErr.message);
    if (isRace) {
      await sb
        .from("commercial_documents")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", newDocId);
      // Karan 2026-07-10 audit fix: the DB row is soft-deleted above,
      // but the FILE was already written to storage before the chain
      // link failed. Without an explicit remove, every race case leaks
      // a bucket file forever. Best-effort remove — swallow errors
      // since the caller only cares about the user-facing message.
      await sb.storage
        .from(STORAGE_BUCKET)
        .remove([uploaded.document.storage_key])
        .catch(() => {});
      return {
        ok: false,
        error: "Someone else just uploaded a new version. Refresh the page and try again.",
      };
    }
    return { ok: false, error: `Chain link failed: ${chainErr.message}` };
  }

  const { error: demoteErr } = await sb
    .from("commercial_documents")
    .update({ status: "superseded" as DocumentStatus })
    .eq("id", prev.id);
  if (demoteErr) {
    console.warn(
      "[commercial/documents] demote-to-superseded failed after version bump:",
      demoteErr.message
    );
    // Don't fail the whole operation — the new version is safely in
    // place, chain link is set. Users can manually re-run the demote
    // via a status transition if needed.
  }

  const doc = chained as CommercialDocument;
  await logUpdate("commercial_documents", doc.id, uploaded.document, doc, input.uploaded_by_user_id);
  return { ok: true, document: doc };
}

// ═══════════════════════════════════════════════════════════════════
// Status transitions
// ═══════════════════════════════════════════════════════════════════

export async function transitionDocumentStatus(
  documentId: string,
  toStatus: DocumentStatus,
  acting_user_id: string | null
): Promise<{ ok: true; document: CommercialDocument } | { ok: false; error: string }> {
  const prev = await getDocument(documentId);
  if (!prev) return { ok: false, error: "Document not found." };
  if (toStatus === "superseded") {
    return { ok: false, error: "Superseded is set automatically when a new version is uploaded." };
  }
  if (!canTransitionDocumentStatus(prev.status, toStatus)) {
    return {
      ok: false,
      error: `Can't move from ${prev.status} → ${toStatus}.`,
    };
  }
  if (isTerminalDocumentStatus(prev.status)) {
    return { ok: false, error: `${prev.status} is a terminal status.` };
  }

  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_documents")
    .update({ status: toStatus })
    .eq("id", documentId)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  const doc = data as CommercialDocument;
  await logUpdate("commercial_documents", documentId, prev, doc, acting_user_id);
  return { ok: true, document: doc };
}

// ═══════════════════════════════════════════════════════════════════
// Favorites — with the 5-per-(parent, category) soft cap enforced here.
// ═══════════════════════════════════════════════════════════════════

export async function favoriteDocument(
  documentId: string,
  acting_user_id: string | null
): Promise<{ ok: true; document: CommercialDocument } | { ok: false; error: string }> {
  const prev = await getDocument(documentId);
  if (!prev) return { ok: false, error: "Document not found." };
  if (prev.favorited_at) return { ok: true, document: prev }; // idempotent

  const sb = commercialDb();
  // Count current favorites in this (parent, category). We're about to
  // add one, so the current count must be strictly less than the cap.
  const { count } = await sb
    .from("commercial_documents")
    .select("id", { count: "exact", head: true })
    .eq("parent_type", prev.parent_type)
    .eq("parent_id", prev.parent_id)
    .eq("category", prev.category)
    .not("favorited_at", "is", null)
    .is("deleted_at", null);
  if ((count ?? 0) >= MAX_FAVORITES_PER_CATEGORY) {
    return {
      ok: false,
      error: `You already have ${MAX_FAVORITES_PER_CATEGORY} favorites for this category — unfavorite one first.`,
    };
  }

  const { data, error } = await sb
    .from("commercial_documents")
    .update({ favorited_at: new Date().toISOString() })
    .eq("id", documentId)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  const doc = data as CommercialDocument;
  await logUpdate("commercial_documents", documentId, prev, doc, acting_user_id);
  return { ok: true, document: doc };
}

export async function unfavoriteDocument(
  documentId: string,
  acting_user_id: string | null
): Promise<{ ok: true; document: CommercialDocument } | { ok: false; error: string }> {
  const prev = await getDocument(documentId);
  if (!prev) return { ok: false, error: "Document not found." };
  if (!prev.favorited_at) return { ok: true, document: prev };

  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_documents")
    .update({ favorited_at: null })
    .eq("id", documentId)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  const doc = data as CommercialDocument;
  await logUpdate("commercial_documents", documentId, prev, doc, acting_user_id);
  return { ok: true, document: doc };
}

// ═══════════════════════════════════════════════════════════════════
// Soft delete + signed download URL
// ═══════════════════════════════════════════════════════════════════

export async function softDeleteDocument(
  documentId: string,
  acting_user_id: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const prev = await getDocument(documentId);
  if (!prev) return { ok: false, error: "Document not found." };
  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_documents")
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by_user_id: acting_user_id,
    })
    .eq("id", documentId);
  if (error) return { ok: false, error: error.message };
  await logDelete("commercial_documents", documentId, prev, acting_user_id);
  return { ok: true };
}

/**
 * Signed download URL — one-shot, expires in 5 minutes. The caller
 * (usually an API route or server action) is responsible for its own
 * auth check before generating the URL.
 */
export async function getDocumentDownloadUrl(
  documentId: string
): Promise<{ ok: true; url: string; file_name: string } | { ok: false; error: string }> {
  const doc = await getDocument(documentId);
  if (!doc) return { ok: false, error: "Document not found." };
  const sb = commercialDb();
  const { data, error } = await sb.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(doc.storage_key, 300);
  if (error || !data) {
    return { ok: false, error: error?.message ?? "Signed URL failed." };
  }
  return { ok: true, url: data.signedUrl, file_name: doc.file_name };
}
