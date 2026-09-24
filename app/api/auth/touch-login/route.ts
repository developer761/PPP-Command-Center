import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { touchLastLogin } from "@/lib/auth/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stamp "last signed in" after an email + password sign-in.
 *
 * `upsertProfile` records it, but it only runs in the Google OAuth callback —
 * so for everybody who signs in with a password it was never written at all.
 * That is every Tomco user: Settings → Access showed Brendan and Stephanie as
 * last seen 2026-07-31 while both were using the platform that day, and it is
 * the column you would read to answer "is anyone actually using this?".
 *
 * Takes no body and trusts no input: the user is whoever the session cookie
 * says, so this cannot be used to stamp somebody else.
 */
export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  await touchLastLogin(user.id);
  return NextResponse.json({ ok: true });
}
