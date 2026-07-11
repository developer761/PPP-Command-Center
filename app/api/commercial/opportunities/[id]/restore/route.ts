import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { restoreCommercialOpportunity } from "@/lib/commercial/opportunities/mutations";
import { UUID_RE } from "@/lib/commercial/uuid";

/**
 * POST /api/commercial/opportunities/[id]/restore
 *
 * Powers the undo-toast Karan requested 2026-07-11 — un-tombstones an
 * opportunity that was soft-deleted in the last few minutes. Also
 * cascade-restores invoices that the delete tombstoned in the same
 * window.
 *
 * Same auth gate as the other Commercial CC API routes:
 *   auth check → `profile.has_new_platform_access` → UUID validate →
 *   mutation lib enforces "must currently be deleted" invariant.
 *
 * Returns { ok: true } on success. 4xx on auth/validation failures,
 * 500 on mutation failure. Client re-navigates so revalidate fires.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
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
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const result = await restoreCommercialOpportunity(id, auth.user.id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
