import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  uploadDocument,
  ALLOWED_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  type DocumentCategory,
  DOCUMENT_CATEGORIES,
} from "@/lib/commercial/accounts/documents";

/**
 * POST /api/commercial/accounts/[id]/documents
 *
 * Multipart upload of a single document. Body fields:
 *   - file       (required, multipart File)
 *   - category   (required, one of DOCUMENT_CATEGORIES)
 *   - expires_at (optional, ISO date — for COI / insurance certs)
 *   - notes      (optional)
 *
 * Auth: any signed-in user with Commercial CC access. The Documents tab
 * doesn't surface this route to readers; only the tab's upload form
 * triggers it.
 *
 * Validation lives in lib/commercial/accounts/documents.uploadDocument —
 * we just shuttle the multipart payload + the auth context.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    if (!data?.user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { id: accountId } = await params;
    if (!accountId || !/^[0-9a-f-]{36}$/i.test(accountId)) {
      return NextResponse.json({ error: "invalid_account_id" }, { status: 400 });
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const categoryRaw = String(formData.get("category") ?? "");
    const expiresAt = (formData.get("expires_at") as string) || null;
    const notes = (formData.get("notes") as string) || null;

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file_required" }, { status: 400 });
    }
    if (!DOCUMENT_CATEGORIES.includes(categoryRaw as DocumentCategory)) {
      return NextResponse.json({ error: "invalid_category" }, { status: 400 });
    }
    const category = categoryRaw as DocumentCategory;

    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: "file_too_big", detail: `Max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.` },
        { status: 413 }
      );
    }
    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      return NextResponse.json(
        { error: "mime_not_allowed", detail: file.type || "(unknown type)" },
        { status: 415 }
      );
    }

    const buffer = new Uint8Array(await file.arrayBuffer());
    const result = await uploadDocument({
      account_id: accountId,
      category,
      file_name: file.name,
      size_bytes: file.size,
      mime_type: file.type,
      expires_at: expiresAt,
      notes,
      data: buffer,
      uploaded_by_user_id: data.user.id,
    });

    if (!result.ok) {
      return NextResponse.json({ error: "upload_failed", detail: result.error }, { status: 500 });
    }
    return NextResponse.json({ ok: true, document: result.document });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[commercial/documents] unhandled: ${message}`);
    return NextResponse.json({ error: "internal_error", detail: message }, { status: 500 });
  }
}
