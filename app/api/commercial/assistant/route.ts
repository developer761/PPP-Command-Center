import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { askAssistant } from "@/lib/commercial/assistant/ask";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The assistant's endpoint.
 *
 * Behind the same access check as every commercial page — it can read the
 * company's money, so it is not open to anyone with the URL.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });
  try {
    await assertCommercialAccess(user.id);
  } catch {
    return NextResponse.json({ ok: false, error: "No access to the commercial platform." }, { status: 403 });
  }

  let body: { question?: string; history?: { role: "user" | "assistant"; content: string }[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  const question = String(body.question ?? "").slice(0, 2_000);
  const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
  const res = await askAssistant(question, history);
  return NextResponse.json(res, { status: res.ok ? 200 : 200 });
}
