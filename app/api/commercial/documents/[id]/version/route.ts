import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  bumpDocumentVersion,
  getDocument,
  ALLOWED_MIME_TYPES,
  MAX_UPLOAD_BYTES,
} from "@/lib/commercial/documents/db";
import { verifyFileMagicBytes } from "@/lib/commercial/accounts/documents";
import { commercialDb } from "@/lib/commercial/db";

/**
 * POST /api/commercial/documents/[id]/version
 *
 * Uploads a NEW version of an existing document. Same multipart shape
 * as the create route (`file` + optional `notes`), but category +
 * parent_type + parent_id are inherited from the previous version —
 * the user shouldn't have to re-pick them.
 *
 * On success the OLD row is set to status='superseded' (the only path
 * to that terminal status) and the new row becomes the head of the
 * chain with version = prev.version + 1.
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

    const { id: previousDocumentId } = await params;
    if (!previousDocumentId || !/^[0-9a-f-]{36}$/i.test(previousDocumentId)) {
      return NextResponse.json({ error: "invalid_document_id" }, { status: 400 });
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

    // Grab the previous version so we can also verify its parent opp
    // is still live — a soft-deleted opp shouldn't be receiving new
    // versions of its files.
    const prev = await getDocument(previousDocumentId);
    if (!prev) {
      return NextResponse.json({ error: "previous_version_not_found" }, { status: 404 });
    }
    if (prev.parent_type === "opportunity") {
      const { data: opp } = await sb
        .from("commercial_opportunities")
        .select("id, deleted_at")
        .eq("id", prev.parent_id)
        .maybeSingle();
      if (!opp || (opp as { deleted_at?: string | null }).deleted_at) {
        return NextResponse.json({ error: "parent_gone" }, { status: 404 });
      }
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const notesRaw = String(formData.get("notes") ?? "").trim();
    const notes = notesRaw.length > 0 ? notesRaw.slice(0, 500) : null;

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "file_required" }, { status: 400 });
    }
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
    const magicCheck = verifyFileMagicBytes(buffer, file.type);
    if (!magicCheck.ok) {
      return NextResponse.json(
        {
          error: "file_content_mismatch",
          detail: `Declared as ${file.type || "(unknown)"} but the file looks like ${magicCheck.detected}.`,
        },
        { status: 415 }
      );
    }

    const result = await bumpDocumentVersion({
      previous_document_id: previousDocumentId,
      file_name: file.name,
      size_bytes: file.size,
      mime_type: file.type,
      notes,
      data: buffer,
      uploaded_by_user_id: authData.user.id,
    });

    if (!result.ok) {
      return NextResponse.json({ error: "version_bump_failed", detail: result.error }, { status: 500 });
    }
    return NextResponse.json({ ok: true, document: result.document });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[commercial/documents/version] POST error:", message);
    return NextResponse.json({ error: "server_error", detail: message }, { status: 500 });
  }
}
