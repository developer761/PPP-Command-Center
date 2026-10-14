/**
 * REPAIR MESSAGES THAT ARRIVED WITHOUT THEIR TEXT.
 *
 *   GET  /api/admin/inbox/backfill-bodies        — dry run, reports only
 *   POST /api/admin/inbox/backfill-bodies        — writes the bodies back
 *
 * Resend's inbound webhook carries metadata only, so the body is fetched
 * separately by id. Through 2026-10-14 that call returned HTTP 401 on every
 * message: the API key could send mail but not read received mail. Replies
 * threaded correctly and arrived with no text, and the hub said the vendor
 * had written nothing.
 *
 * Once the key can read, the text is still sitting in Resend — the webhook
 * just has no reason to run again for a message it already stored. This
 * fetches it for anything stored without a body.
 *
 * It doubles as the proof the key is fixed. A dry run reports exactly what
 * the receiving API says per message, so "is the key right?" is answerable
 * in one request instead of by sending another test email and waiting.
 *
 * ADMIN ONLY, and the dry run is the default: a GET changes nothing.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { roleForProfile } from "@/lib/auth/roles";
import { fetchReceivedEmail } from "@/lib/email/resend-receiving";

export const dynamic = "force-dynamic";

function adminDb() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

async function run(write: boolean) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const profile = await getProfileByUserId(auth.user.id);
  // Admin only. This reads message bodies across every work order, which is
  // wider than the scope-gated Mail Hub hands a rep.
  if (roleForProfile(profile, isAdminEmail(auth.user.email)) !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const sb = adminDb();
  const { data: rows, error } = await sb
    .from("inbox_messages")
    .select("id, subject, received_at, body_text, body_html, raw_payload")
    .is("body_text", null)
    .order("received_at", { ascending: false })
    .limit(50);
  if (error) {
    return NextResponse.json({ error: "query_failed", message: error.message }, { status: 500 });
  }

  const results: Array<Record<string, unknown>> = [];
  let repaired = 0;
  let unreadable = 0;

  for (const r of rows ?? []) {
    const payload = (r.raw_payload ?? {}) as { data?: { email_id?: string } };
    const emailId = payload.data?.email_id ?? null;
    if (!emailId) {
      results.push({ id: r.id, subject: r.subject, status: "no_email_id_in_payload" });
      continue;
    }
    const fetched = await fetchReceivedEmail(emailId);
    if (!fetched) {
      unreadable++;
      results.push({
        id: r.id,
        subject: r.subject,
        status: "fetch_failed",
        // The whole point of the dry run: say WHY, not just that it failed.
        hint: "Resend refused the read. Check RESEND_API_KEY has Full access, not Sending access.",
      });
      continue;
    }
    const gotSomething = Boolean(fetched.text || fetched.html);
    if (!gotSomething) {
      results.push({ id: r.id, subject: r.subject, status: "resend_has_no_body" });
      continue;
    }
    if (!write) {
      results.push({
        id: r.id,
        subject: r.subject,
        status: "would_repair",
        preview: (fetched.text ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || "(html only)",
      });
      continue;
    }
    const { error: updErr } = await sb
      .from("inbox_messages")
      .update({ body_text: fetched.text, body_html: fetched.html })
      .eq("id", r.id);
    if (updErr) {
      results.push({ id: r.id, subject: r.subject, status: "update_failed", message: updErr.message });
      continue;
    }
    repaired++;
    results.push({
      id: r.id,
      subject: r.subject,
      status: "repaired",
      preview: (fetched.text ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || "(html only)",
    });
  }

  return NextResponse.json({
    ok: true,
    mode: write ? "write" : "dry_run",
    bodyless_messages_found: rows?.length ?? 0,
    repaired,
    unreadable,
    keyCanReadReceivedEmail: (rows?.length ?? 0) === 0 ? null : unreadable === 0,
    results,
  });
}

export async function GET() {
  return run(false);
}

export async function POST() {
  return run(true);
}
