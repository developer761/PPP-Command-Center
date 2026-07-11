import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { restoreAccountNote } from "@/lib/commercial/account-notes";
import { UUID_RE } from "@/lib/commercial/uuid";

/**
 * POST /api/commercial/notes/[id]/restore
 *
 * Undo-toast endpoint for account notes. Same auth gate as other
 * Commercial CC API routes (has_new_platform_access).
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sb = commercialDb();
  const { data: profile } = await sb
    .from("profiles")
    .select("has_new_platform_access")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!(profile as { has_new_platform_access?: boolean } | null)?.has_new_platform_access) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });
  const result = await restoreAccountNote(id, auth.user.id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
