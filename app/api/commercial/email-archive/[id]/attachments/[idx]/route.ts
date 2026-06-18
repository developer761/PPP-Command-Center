import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";

/**
 * GET /api/commercial/email-archive/[id]/attachments/[idx]
 *
 * Redirects (302) to a Supabase Storage signed URL for the indexed
 * attachment on an archived email. 5-minute TTL — short enough that
 * accidentally-shared links can't leak long-term, long enough for a
 * browser download to start without races.
 *
 * Auth: signed-in user with `has_new_platform_access`. We don't
 * fine-grain on opp/account team membership at this stage because the
 * email itself is already visible in the same tab — anyone who can see
 * the parent record can already see the email metadata, so gating
 * attachment access at team-membership level would mean adding a much
 * larger access-check matrix. Stage-2 trade-off; revisit if PPP adds
 * sub-team siloing.
 *
 * Refuses to issue a URL when:
 *   - The email row is soft-deleted (deleted_at IS NOT NULL)
 *   - The parent opp/account is soft-deleted
 *   - idx is out of bounds
 *   - The signed URL request itself fails
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; idx: string }> }
) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id, idx: idxStr } = await params;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "invalid_email_id" }, { status: 400 });
  }
  const idx = Number(idxStr);
  if (!Number.isInteger(idx) || idx < 0) {
    return NextResponse.json({ error: "invalid_idx" }, { status: 400 });
  }

  const sb = commercialDb();

  // Platform-access gate — a Command Center-only user with a valid
  // session must not download Commercial CC attachments.
  const { data: profile } = await sb
    .from("profiles")
    .select("has_new_platform_access, is_active")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!profile?.has_new_platform_access || profile?.is_active === false) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { data: email, error } = await sb
    .from("commercial_archived_emails")
    .select("id, source_kind, source_id, attachments, deleted_at")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  }
  if (!email || email.deleted_at) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Cascade-soft-delete gate — if the parent opp/account was soft-deleted
  // after the email was archived, refuse to issue the download. The email
  // itself already drops out of the UI via listArchivedEmails -> we don't
  // surface a parent_deleted email -> the only path to here is a stale
  // browser tab or a hand-crafted URL.
  const row = email as {
    source_kind: "opp" | "acc";
    source_id: string;
    attachments: unknown;
  };
  if (row.source_kind === "opp") {
    const { data: opp } = await sb
      .from("commercial_opportunities")
      .select("id, deleted_at")
      .eq("id", row.source_id)
      .maybeSingle();
    if (!opp || opp.deleted_at) {
      return NextResponse.json({ error: "parent_deleted" }, { status: 404 });
    }
  } else {
    const { data: acc } = await sb
      .from("commercial_accounts")
      .select("id, deleted_at")
      .eq("id", row.source_id)
      .maybeSingle();
    if (!acc || acc.deleted_at) {
      return NextResponse.json({ error: "parent_deleted" }, { status: 404 });
    }
  }

  const attachments = Array.isArray(row.attachments) ? row.attachments : [];
  const attachment = attachments[idx] as
    | { filename: string; storage_key: string; mime_type: string }
    | undefined;
  if (!attachment || !attachment.storage_key) {
    return NextResponse.json({ error: "attachment_missing" }, { status: 404 });
  }

  const { data: signed, error: signErr } = await sb.storage
    .from("commercial-email-attachments")
    .createSignedUrl(attachment.storage_key, 5 * 60);
  if (signErr || !signed?.signedUrl) {
    console.warn(
      "[email-archive/download] signed URL failed:",
      signErr?.message ?? "no_url"
    );
    return NextResponse.json({ error: "sign_failed" }, { status: 500 });
  }
  return NextResponse.redirect(signed.signedUrl, 302);
}
