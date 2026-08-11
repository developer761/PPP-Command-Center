import { NextResponse } from "next/server";
import { denyCrewApi } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { invalidateProfileCache } from "@/lib/auth/profile";

export const runtime = "nodejs";

/**
 * POST /api/commercial/onboarding/seen — R7.
 *
 * Stamp the current user's profile so the one-time Commercial onboarding
 * walkthrough never shows again. Idempotent. Invalidates the 30s profile
 * cache so the very next navigation reads the fresh "seen" state (otherwise
 * the tour could flicker back for up to 30s).
 */
export async function POST() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Crew logins are page-allowlisted only; this API tree is not covered by
  // that gate, so deny here (see denyCrewApi).
  { const denied = await denyCrewApi(data?.user?.id); if (denied) return denied; }

  const sb = commercialDb();
  const { error } = await sb
    .from("profiles")
    .update({ commercial_onboarding_seen_at: new Date().toISOString() })
    .eq("user_id", data.user.id)
    .is("commercial_onboarding_seen_at", null); // don't overwrite an earlier stamp
  if (error) {
    return NextResponse.json({ error: "update_failed", detail: error.message }, { status: 500 });
  }
  invalidateProfileCache(data.user.id);
  return NextResponse.json({ ok: true });
}
