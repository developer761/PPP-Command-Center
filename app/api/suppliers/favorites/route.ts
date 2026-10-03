import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { resolveViewer } from "@/lib/auth/viewer-server";

/**
 * The signed-in user's starred vendors (Katie, 2026-10-01: "a user's favorited
 * vendors").
 *
 * DELIBERATELY SEPARATE from /api/suppliers/active, which is the same list for
 * everybody and is served with a 30-second cache. Folding per-user rows into
 * that response would mean either giving up the cache for all of it, or
 * handing one person's favorites to the next request — which is not
 * hypothetical now that an admin can proxy-log-in as somebody else.
 *
 * So: the vendor list stays global and cached, this is tiny and uncached, and
 * the client merges them.
 *
 *   GET    → { favorites: string[], userState: string | null }
 *   POST   { supplierAccountId }       star
 *   DELETE { supplierAccountId }       unstar
 *
 * Any signed-in user, like the vendor list itself — a worker picks vendors too,
 * and a favorite is a preference, not a permission.
 */
export const dynamic = "force-dynamic";

function db() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/** The real signed-in person. A proxy session stars for whoever is being
 *  acted as, which is what "see their view" means. */
async function viewerId(): Promise<string | null> {
  const viewer = await resolveViewer({});
  return viewer?.supabaseUserId ?? null;
}

function noStore(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET() {
  const userId = await viewerId();
  if (!userId) return noStore({ error: "unauthorized" }, 401);

  const sb = db();
  const [fav, prof] = await Promise.all([
    sb.from("supplier_favorites").select("supplier_account_id").eq("user_id", userId),
    // The person's own state, which is what the vendor list filters on
    // (Katie 2026-10-02). Carried on THIS response rather than threaded down
    // from the page: it is per-user, like the favorites, and the vendor list
    // itself stays global and cached.
    sb.from("profiles").select("state").eq("user_id", userId).maybeSingle(),
  ]);

  // Either column missing (migration not pasted yet) must not take the vendor
  // picker down with it — an unfiltered, unsorted list is still a working one.
  const userState = ((prof.data as { state?: string | null } | null)?.state ?? "").trim().toUpperCase() || null;
  if (fav.error) return noStore({ favorites: [], userState, degraded: true, message: fav.error.message });
  return noStore({
    favorites: (fav.data ?? []).map((r) => r.supplier_account_id as string),
    userState,
  });
}

async function readId(request: Request): Promise<string | null> {
  try {
    const body = (await request.json()) as { supplierAccountId?: string };
    const id = String(body.supplierAccountId ?? "").trim();
    return id || null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const userId = await viewerId();
  if (!userId) return noStore({ error: "unauthorized" }, 401);
  const supplierAccountId = await readId(request);
  if (!supplierAccountId) return noStore({ error: "missing_supplier" }, 400);

  // Idempotent: starring twice is a no-op, not a duplicate-key error. The
  // primary key is (user_id, supplier_account_id).
  const { error } = await db()
    .from("supplier_favorites")
    .upsert({ user_id: userId, supplier_account_id: supplierAccountId }, { onConflict: "user_id,supplier_account_id" });
  if (error) return noStore({ error: "write_failed", message: error.message }, 500);
  return noStore({ ok: true });
}

export async function DELETE(request: Request) {
  const userId = await viewerId();
  if (!userId) return noStore({ error: "unauthorized" }, 401);
  const supplierAccountId = await readId(request);
  if (!supplierAccountId) return noStore({ error: "missing_supplier" }, 400);

  const { error } = await db()
    .from("supplier_favorites")
    .delete()
    .eq("user_id", userId)
    .eq("supplier_account_id", supplierAccountId);
  if (error) return noStore({ error: "write_failed", message: error.message }, 500);
  return noStore({ ok: true });
}
