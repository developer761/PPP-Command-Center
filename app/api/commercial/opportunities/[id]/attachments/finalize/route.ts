import { NextResponse } from "next/server";
import { denyCrewApi } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { finalizeAttachmentUpload } from "@/lib/commercial/opportunities/attachment-upload";
import { linkAttachmentToSubmittal } from "@/lib/commercial/opportunities/attachments";
import { UUID_RE } from "@/lib/commercial/uuid";

export const runtime = "nodejs";

/**
 * POST /api/commercial/opportunities/[id]/attachments/finalize
 *
 * Step 3 of the direct-to-Storage upload: the browser has PUT the file, this
 * confirms it landed, sniffs its head for a magic-byte match, and inserts the
 * (auto-versioned) metadata row. Body: { storage_key, file_name, mime_type,
 * notes?, submittal_id? }.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    if (!data?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    { const denied = await denyCrewApi(data?.user?.id); if (denied) return denied; }

    const { id: opportunity_id } = await params;
    if (!opportunity_id || !UUID_RE.test(opportunity_id)) {
      return NextResponse.json({ error: "invalid_opportunity_id" }, { status: 400 });
    }

    const sb = commercialDb();
    const { data: profile } = await sb
      .from("profiles")
      .select("has_new_platform_access, is_active")
      .eq("user_id", data.user.id)
      .maybeSingle();
    if (!profile?.has_new_platform_access || profile?.is_active === false) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    }

    const result = await finalizeAttachmentUpload({
      opportunity_id,
      storage_key: String(body.storage_key ?? ""),
      file_name: String(body.file_name ?? "").slice(0, 300),
      mime_type: String(body.mime_type ?? ""),
      notes: typeof body.notes === "string" ? body.notes : null,
      uploaded_by_user_id: data.user.id,
    });
    if (!result.ok) {
      return NextResponse.json({ error: "upload_failed", detail: result.error }, { status: 400 });
    }

    // Optional auto-link to a submittal — same as the multipart path. Silent on
    // failure: the upload already succeeded and the file shows in the unlinked
    // list on Plans & Specs for manual linking.
    const rawSubmittalId = typeof body.submittal_id === "string" ? body.submittal_id : null;
    if (rawSubmittalId && UUID_RE.test(rawSubmittalId)) {
      const link = await linkAttachmentToSubmittal(opportunity_id, rawSubmittalId, result.attachment.id, data.user.id);
      if (!link.ok) console.warn(`[commercial/opp-attachments/finalize] auto-link failed: ${link.error}`);
    }

    return NextResponse.json({ ok: true, attachment: result.attachment });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[commercial/opp-attachments/finalize] unhandled: ${message}`);
    return NextResponse.json({ error: "internal_error", detail: message }, { status: 500 });
  }
}
