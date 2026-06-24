import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  uploadDocument,
  ALLOWED_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  verifyFileMagicBytes,
  type DocumentCategory,
  DOCUMENT_CATEGORIES,
} from "@/lib/commercial/accounts/documents";
import { commercialDb } from "@/lib/commercial/db";

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

    // Gate on Commercial CC access — a Command Center-only user with a
    // valid session must not be able to upload commercial docs.
    const sb = commercialDb();
    const { data: profile } = await sb
      .from("profiles")
      .select("has_new_platform_access")
      .eq("user_id", data.user.id)
      .maybeSingle();
    if (!profile?.has_new_platform_access) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    // Refuse uploads to a missing or soft-deleted account.
    const { data: account } = await sb
      .from("commercial_accounts")
      .select("id, deleted_at")
      .eq("id", accountId)
      .maybeSingle();
    if (!account || account.deleted_at) {
      return NextResponse.json({ error: "account_not_found" }, { status: 404 });
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const categoryRaw = String(formData.get("category") ?? "");
    // Three states for expires_at:
    //   - field absent (formData.has === false) → pass undefined to the lib so the
    //     category default kicks in (1 year for COI/W-9/MSA, null for others)
    //   - field present + empty string → pass explicit null (user picked "No expiry")
    //   - field present + non-empty → pass the ISO date string
    // The previous `|| null` collapsed the first two cases, defeating "Auto" mode.
    let expiresAt: string | null | undefined;
    if (!formData.has("expires_at")) {
      expiresAt = undefined;
    } else {
      const raw = String(formData.get("expires_at") ?? "").trim();
      expiresAt = raw === "" ? null : raw;
    }
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

    // Magic-byte sniff: the browser-reported MIME is user-spoofable
    // (rename malware.exe → invoice.pdf and it'll declare application/pdf).
    // Read the first 12 bytes and verify they match the declared type.
    // Executables and unknown signatures fail closed.
    const magicCheck = verifyFileMagicBytes(buffer, file.type);
    if (!magicCheck.ok) {
      return NextResponse.json(
        {
          error: "file_content_mismatch",
          detail: `Declared as ${file.type || "(unknown)"} but the file looks like ${magicCheck.detected}. If you're sure this is the right document, try saving/exporting it again from the source app.`,
        },
        { status: 415 }
      );
    }

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
