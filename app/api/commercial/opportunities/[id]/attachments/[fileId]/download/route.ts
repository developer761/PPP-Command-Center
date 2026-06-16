import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { getOpportunityAttachmentSignedUrl } from "@/lib/commercial/opportunities/attachments";
import { UUID_RE } from "@/lib/commercial/uuid";

/**
 * GET /api/commercial/opportunities/[id]/attachments/[fileId]/download
 *
 * 302 redirect to a fresh Supabase Storage signed URL (5-min TTL).
 * Mirrors the Phase 1 doc-download pattern: signed URL regenerated on
 * every click so a stale link from yesterday still works.
 *
 * Auth: signed in + has_new_platform_access. Defense in depth: the
 * attachment must belong to the opp the URL claims.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id: opportunity_id, fileId } = await params;
  if (!opportunity_id || !UUID_RE.test(opportunity_id)) {
    return NextResponse.json({ error: "invalid_opportunity_id" }, { status: 400 });
  }
  if (!fileId || !UUID_RE.test(fileId)) {
    return NextResponse.json({ error: "invalid_file_id" }, { status: 400 });
  }

  const sb = commercialDb();

  // Commercial CC access gate.
  const { data: profile } = await sb
    .from("profiles")
    .select("has_new_platform_access")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!profile?.has_new_platform_access) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { data: row } = await sb
    .from("commercial_opportunity_attachments")
    .select("storage_key, opportunity_id")
    .eq("id", fileId)
    .maybeSingle();
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const att = row as { storage_key: string; opportunity_id: string };

  // Defense in depth: the file must belong to the opp claimed in the URL.
  if (att.opportunity_id !== opportunity_id) {
    return NextResponse.json({ error: "attachment_opportunity_mismatch" }, { status: 403 });
  }

  const signed = await getOpportunityAttachmentSignedUrl(att.storage_key, 5 * 60);
  if (!signed) {
    return NextResponse.json({ error: "signed_url_failed" }, { status: 500 });
  }
  return NextResponse.redirect(signed, 302);
}
