import { NextResponse } from "next/server";
import { apiAccessDenied } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { extractRfp } from "@/lib/commercial/rfp/extract";

/**
 * POST /api/commercial/rfp/extract  { text: string }
 *
 * Runs the paste-box RFP text through Claude and returns the structured fields
 * for the New-from-RFP review form. Extract only — nothing is created here.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const sb = commercialDb();
  const { data: prof } = await sb
    .from("profiles")
    .select("has_new_platform_access, is_active")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (await apiAccessDenied(auth.user.id, prof)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let text = "";
  try {
    const body = (await req.json()) as { text?: unknown };
    text = typeof body.text === "string" ? body.text : "";
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  const result = await extractRfp(text);
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 200 });
  return NextResponse.json({ ok: true, extract: result.extract }, { status: 200 });
}
