import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { signDocumentUpload } from "@/lib/commercial/documents/large-upload";
import { UUID_RE } from "@/lib/commercial/uuid";

export const runtime = "nodejs";

/**
 * POST /api/commercial/opportunities/[id]/documents/sign
 *
 * Step 1 of the R6b large-file (up to 100 MB) upload flow for the Documents
 * system. Mints a one-time signed upload URL so the browser can PUT the file
 * straight to Supabase Storage, bypassing Vercel's ~4.5 MB serverless body cap.
 * No bytes touch this route — just JSON { file_name, mime_type, size_bytes }.
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

    const result = await signDocumentUpload({
      parent_type: "opportunity",
      parent_id: opportunity_id,
      file_name: String(body.file_name ?? "").slice(0, 300),
      mime_type: String(body.mime_type ?? ""),
      size_bytes: Number(body.size_bytes ?? 0),
    });
    if (!result.ok) {
      return NextResponse.json({ error: "sign_failed", detail: result.error }, { status: 400 });
    }
    return NextResponse.json({
      ok: true,
      bucket: result.bucket,
      storage_key: result.storage_key,
      token: result.token,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[commercial/documents/sign] unhandled: ${message}`);
    return NextResponse.json({ error: "internal_error", detail: message }, { status: 500 });
  }
}
