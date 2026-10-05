import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { updateUserState } from "@/lib/auth/user-management";

/**
 * The signed-in person sets their OWN work state, which filters the vendors
 * they can order from.
 *
 * Karan 2026-10-05: "everyone can set their own states by clicking account
 * settings on the top right and they add their own states and moving forward
 * as well." Before this the only way in was Settings → Access & Users, which
 * is admin-only — so rolling out to twenty people meant an admin typing twenty
 * two-letter codes, and every new hire afterwards waiting on one.
 *
 * Why this can live outside `app/api/admin/`: the body carries ONLY a state.
 * There is no user_id to tamper with — the row written is always the caller's,
 * resolved from their session. The same reasoning as the sibling
 * `/api/account/phone`.
 *
 * It deliberately delegates to `updateUserState` rather than writing the column
 * itself, which is what `/api/account/phone` does. That helper is the one place
 * that validates the code, clears the 30-second profile cache, and writes the
 * audit row — a second hand-rolled UPDATE here would have drifted from it the
 * first time any of those three changed, and a stale cache in particular shows
 * up as "I set my state and the vendor list didn't change."
 *
 *   POST { state: "NJ" }  → { ok: true, state: "NJ" }
 *   POST { state: "" }    → { ok: true, state: null }   clears it
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data, error: authError } = await supabase.auth.getUser();
  if (authError || !data.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // IMPORTANT: `supabase.auth.getUser()` is proxy-blind — it is always the real
  // signed-in person, never a proxy target. That is deliberate and it has to
  // stay that way: /api/suppliers/favorites reads the state back with the same
  // real id, so writing to anyone else's row would save a value the vendor
  // picker never reads.
  const userId = data.user.id;

  let state: string | null = null;
  try {
    const body = (await request.json()) as { state?: unknown };
    state = typeof body.state === "string" ? body.state : null;
  } catch {
    return NextResponse.json(
      { error: "bad_request", message: "Couldn't read that. Try again." },
      { status: 400 }
    );
  }

  const result = await updateUserState({
    user_id: userId,
    state,
    // The person is the actor as well as the target, so the audit row reads as
    // somebody changing their own state rather than an admin changing it for
    // them — worth being able to tell apart later.
    actor: { user_id: userId, email: data.user.email ?? "" },
  });

  if (!result.ok) {
    return NextResponse.json({ error: "write_failed", message: result.error }, { status: 400 });
  }

  const normalized = (state ?? "").trim().toUpperCase() || null;
  return NextResponse.json({ ok: true, state: normalized });
}
