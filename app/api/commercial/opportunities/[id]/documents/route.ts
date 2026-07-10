import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  uploadDocument,
  ALLOWED_MIME_TYPES,
  MAX_UPLOAD_BYTES,
} from "@/lib/commercial/documents/db";
import { verifyFileMagicBytes } from "@/lib/commercial/accounts/documents";
import { isValidDocumentCategory } from "@/lib/commercial/documents/categories";
import { commercialDb } from "@/lib/commercial/db";

/**
 * POST /api/commercial/opportunities/[id]/documents
 *
 * Multipart upload for the new polymorphic Files tab on Opportunities
 * (Phase C). Body fields:
 *   - file      (required, multipart File)
 *   - category  (optional; defaults to "other" — never blocks upload)
 *   - notes     (optional, ≤ 500 chars)
 *
 * Auth: signed-in user with `has_new_platform_access = TRUE`. Same gate
 * as every other Commercial CC route.
 *
 * Chain-of-trust:
 *   1. Route validates auth + platform access + opp existence + file
 *      size + MIME whitelist + magic-byte sniff (all fail-fast).
 *   2. lib/commercial/documents/db.ts `uploadDocument` re-runs size +
 *      MIME + magic-byte checks (defense in depth) and does the Storage
 *      upload + metadata insert.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient();
    const { data: authData } = await supabase.auth.getUser();
    if (!authData?.user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { id: opportunityId } = await params;
    if (!opportunityId || !/^[0-9a-f-]{36}$/i.test(opportunityId)) {
      return NextResponse.json({ error: "invalid_opportunity_id" }, { status: 400 });
    }

    const sb = commercialDb();
    const { data: profile } = await sb
      .from("profiles")
      .select("has_new_platform_access")
      .eq("user_id", authData.user.id)
      .maybeSingle();
    if (!profile?.has_new_platform_access) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const { data: opp } = await sb
      .from("commercial_opportunities")
      .select("id, deleted_at")
      .eq("id", opportunityId)
      .maybeSingle();
    if (!opp || (opp as { deleted_at?: string | null }).deleted_at) {
      return NextResponse.json({ error: "opportunity_not_found" }, { status: 404 });
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const categoryRaw = String(formData.get("category") ?? "other");
    const notesRaw = String(formData.get("notes") ?? "").trim();
    const notes = notesRaw.length > 0 ? notesRaw.slice(0, 500) : null;

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "file_required" }, { status: 400 });
    }

    // Category never blocks upload — spec calls for "other" as safe
    // fallback. Sanitize to a known value here rather than 400ing.
    const category = isValidDocumentCategory(categoryRaw) ? categoryRaw : "other";

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

    // Magic-byte sniff (shared with account-docs). Browser-reported MIME
    // is user-spoofable; the first few bytes are not.
    const magicCheck = verifyFileMagicBytes(buffer, file.type);
    if (!magicCheck.ok) {
      return NextResponse.json(
        {
          error: "file_content_mismatch",
          detail: `Declared as ${file.type || "(unknown)"} but the file looks like ${magicCheck.detected}. If you're sure this is the right document, try re-exporting from the source app.`,
        },
        { status: 415 }
      );
    }

    const result = await uploadDocument({
      parent_type: "opportunity",
      parent_id: opportunityId,
      category,
      file_name: file.name,
      size_bytes: file.size,
      mime_type: file.type,
      notes,
      data: buffer,
      uploaded_by_user_id: authData.user.id,
    });

    if (!result.ok) {
      return NextResponse.json({ error: "upload_failed", detail: result.error }, { status: 500 });
    }
    return NextResponse.json({ ok: true, document: result.document });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[commercial/opportunities/documents] POST error:", message);
    return NextResponse.json({ error: "server_error", detail: message }, { status: 500 });
  }
}
