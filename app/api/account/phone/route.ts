import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * The signed-in person's own phone number.
 *
 * Karan 2026-09-09: "who should the supplier call — it should be the person
 * who's logged in, and we can add numbers by going to the profile, account
 * settings, save a number there, and it should always populate in the email."
 *
 * Everything downstream of this already existed: `profiles.phone` (migration
 * 145), loadViewerContact reading it, and the vendor email's contact block
 * printing it. What was missing was any way to SET it — so the field was blank
 * for everyone except one person whose row had been written directly.
 *
 * Self-service only. There is no user_id in the body: a person edits their own
 * number and nobody else's, which is the whole reason this can live outside the
 * admin routes.
 */

const MAX_LEN = 32;

/** Digits, spaces, and the punctuation people actually type in a phone number. */
const PHONE_OK = /^[0-9+()\-.\s x]*$/i;

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { phone?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const raw = typeof body.phone === "string" ? body.phone.trim() : "";
  if (raw.length > MAX_LEN) {
    return NextResponse.json(
      { error: "too_long", message: `Keep it under ${MAX_LEN} characters.` },
      { status: 400 }
    );
  }
  if (raw && !PHONE_OK.test(raw)) {
    // Deliberately permissive: PPP writes numbers several ways and this string
    // is read by a human at a paint counter, not dialled by a machine. The
    // check exists to keep a sentence out of the vendor email, not to enforce
    // a format.
    return NextResponse.json(
      { error: "invalid", message: "That doesn't look like a phone number." },
      { status: 400 }
    );
  }

  try {
    const sb = createSupabaseAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SECRET_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    // Empty string clears it — a person who mistypes must be able to remove it,
    // not be stuck with a wrong number going out on every order.
    const { error } = await sb
      .from("profiles")
      .update({ phone: raw || null })
      .eq("user_id", data.user.id);
    if (error) {
      return NextResponse.json({ error: "save_failed", message: error.message }, { status: 500 });
    }
  } catch (err) {
    return NextResponse.json(
      { error: "save_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, phone: raw || null });
}
