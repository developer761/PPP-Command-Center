import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import {
  uploadOpportunityAttachment,
} from "@/lib/commercial/opportunities/attachments";
import {
  ALLOWED_MIME_TYPES,
  MAX_UPLOAD_BYTES,
} from "@/lib/commercial/accounts/documents";
import { UUID_RE } from "@/lib/commercial/uuid";

/**
 * POST /api/commercial/opportunities/[id]/attachments — multipart upload.
 *
 * Body fields:
 *   - file   (required, multipart File)
 *   - notes  (optional)
 *
 * Auth: signed in + has_new_platform_access. Same gating as Phase 1
 * account documents. Account-existence + opp-existence + soft-delete
 * checks are repeated inside uploadOpportunityAttachment (defense in
 * depth) so the lib never trusts the caller.
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

    const { id: opportunity_id } = await params;
    if (!opportunity_id || !UUID_RE.test(opportunity_id)) {
      return NextResponse.json({ error: "invalid_opportunity_id" }, { status: 400 });
    }

    // Commercial CC platform-access gate.
    const sb = commercialDb();
    const { data: profile } = await sb
      .from("profiles")
      .select("has_new_platform_access")
      .eq("user_id", data.user.id)
      .maybeSingle();
    if (!profile?.has_new_platform_access) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    // Opp existence + soft-delete shortcut (the lib re-checks but a
    // 404 here saves a multipart parse on a doomed request).
    const { data: opp } = await sb
      .from("commercial_opportunities")
      .select("id, deleted_at")
      .eq("id", opportunity_id)
      .maybeSingle();
    if (!opp || opp.deleted_at) {
      return NextResponse.json({ error: "opportunity_not_found" }, { status: 404 });
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const rawNotes = (formData.get("notes") as string) || null;
    // Defense in depth: mirror the form's maxLength=500 server-side so
    // a hand-crafted curl can't dump multi-MB notes into TEXT.
    const notes = rawNotes ? rawNotes.slice(0, 500) : null;

    if (!(file instanceof File)) {
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
    const result = await uploadOpportunityAttachment({
      opportunity_id,
      file_name: file.name,
      size_bytes: file.size,
      mime_type: file.type,
      notes,
      data: buffer,
      uploaded_by_user_id: data.user.id,
    });

    if (!result.ok) {
      return NextResponse.json({ error: "upload_failed", detail: result.error }, { status: 500 });
    }
    return NextResponse.json({ ok: true, attachment: result.attachment });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[commercial/opp-attachments] unhandled: ${message}`);
    return NextResponse.json({ error: "internal_error", detail: message }, { status: 500 });
  }
}
