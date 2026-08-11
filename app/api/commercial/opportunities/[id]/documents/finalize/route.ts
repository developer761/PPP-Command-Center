import { NextResponse } from "next/server";
import { denyCrewApi } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { finalizeDocumentUpload } from "@/lib/commercial/documents/large-upload";
import { UUID_RE } from "@/lib/commercial/uuid";

export const runtime = "nodejs";

/**
 * POST /api/commercial/opportunities/[id]/documents/finalize
 *
 * Step 3 of the R6b large-file upload flow. Called after the browser has PUT
 * the file straight to Storage via the signed URL from /sign. Confirms the
 * object landed, sniffs its head for a magic-byte match, and inserts the v1
 * metadata row. Body: { storage_key, file_name, mime_type, category?, notes? }.
 *
 * Auth: signed in + has_new_platform_access (same gate as documents/route.ts).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    if (!data?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Crew logins are page-allowlisted only; this API tree is not covered by
  // that gate, so deny here (see denyCrewApi).
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

    const rawNotes = typeof body.notes === "string" ? body.notes : null;
    const result = await finalizeDocumentUpload({
      parent_type: "opportunity",
      parent_id: opportunity_id,
      category: typeof body.category === "string" ? body.category : "other",
      storage_key: String(body.storage_key ?? ""),
      file_name: String(body.file_name ?? "").slice(0, 300),
      mime_type: String(body.mime_type ?? ""),
      notes: rawNotes ? rawNotes.slice(0, 500) : null,
      uploaded_by_user_id: data.user.id,
    });
    if (!result.ok) {
      return NextResponse.json({ error: "finalize_failed", detail: result.error }, { status: 400 });
    }
    return NextResponse.json({ ok: true, document: result.document });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[commercial/documents/finalize] unhandled: ${message}`);
    return NextResponse.json({ error: "internal_error", detail: message }, { status: 500 });
  }
}
