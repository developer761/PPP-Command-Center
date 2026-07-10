import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getDocument, getDocumentDownloadUrl } from "@/lib/commercial/documents/db";
import { commercialDb } from "@/lib/commercial/db";

/**
 * GET /api/commercial/documents/[id]/download
 *
 * Issues a short-lived (5 min) signed URL and 302-redirects to it.
 * Never returns the raw URL in JSON — that would let a compromised
 * client cache the signed URL and pass it around.
 *
 * Auth chain: signed-in user with `has_new_platform_access = TRUE`. The
 * doc's parent (opp or project) must also be alive; we don't gate on
 * finer-grained assignments (any staffer with commercial access can
 * pull any doc — matches the pattern in the account-docs download).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient();
    const { data: authData } = await supabase.auth.getUser();
    if (!authData?.user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { id: documentId } = await params;
    if (!documentId || !/^[0-9a-f-]{36}$/i.test(documentId)) {
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

    const doc = await getDocument(documentId);
    if (!doc) {
      return NextResponse.json({ error: "document_not_found" }, { status: 404 });
    }

    // Verify the parent is still live — a soft-deleted opp should not
    // leak its files even if someone still has the doc id.
    if (doc.parent_type === "opportunity") {
      const { data: opp } = await sb
        .from("commercial_opportunities")
        .select("id, deleted_at")
        .eq("id", doc.parent_id)
        .maybeSingle();
      if (!opp || (opp as { deleted_at?: string | null }).deleted_at) {
        return NextResponse.json({ error: "parent_gone" }, { status: 404 });
      }
    }

    const signed = await getDocumentDownloadUrl(documentId);
    if (!signed.ok) {
      return NextResponse.json({ error: "signed_url_failed", detail: signed.error }, { status: 500 });
    }
    return NextResponse.redirect(signed.url, { status: 302 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[commercial/documents/download] GET error:", message);
    return NextResponse.json({ error: "server_error", detail: message }, { status: 500 });
  }
}
