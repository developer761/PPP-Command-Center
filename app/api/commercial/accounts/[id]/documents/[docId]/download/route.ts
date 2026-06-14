import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getDocumentSignedUrl } from "@/lib/commercial/accounts/documents";
import { commercialDb } from "@/lib/commercial/db";

/**
 * GET /api/commercial/accounts/[id]/documents/[docId]/download
 *
 * Returns a 302 redirect to a Supabase Storage signed URL with a 5-minute
 * TTL. Reasons we round-trip through this route instead of building the
 * URL in the page:
 *   1. The signed URL must be requested server-side (uses the service-role
 *      Supabase client).
 *   2. The redirect happens at request time, so the URL is always fresh —
 *      a download link from yesterday still works because each click
 *      generates a NEW signed URL.
 *   3. We can log the download into the audit log later if needed.
 *
 * Auth: any signed-in user. The download itself is gated by Supabase
 * Storage RLS + the signed URL TTL — short-TTL means the link can't be
 * shared accidentally for long.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; docId: string }> }
) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id: accountId, docId } = await params;
  if (!docId || !/^[0-9a-f-]{36}$/i.test(docId)) {
    return NextResponse.json({ error: "invalid_doc_id" }, { status: 400 });
  }

  const sb = commercialDb();
  const { data: doc } = await sb
    .from("commercial_account_documents")
    .select("storage_key, account_id")
    .eq("id", docId)
    .maybeSingle();

  if (!doc) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const row = doc as { storage_key: string; account_id: string };

  // Defense in depth — the doc must belong to the account the URL claims.
  if (row.account_id !== accountId) {
    return NextResponse.json({ error: "doc_account_mismatch" }, { status: 403 });
  }

  const signed = await getDocumentSignedUrl(row.storage_key, 5 * 60);
  if (!signed) {
    return NextResponse.json({ error: "signed_url_failed" }, { status: 500 });
  }

  return NextResponse.redirect(signed, 302);
}
