import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { askAssistant } from "@/lib/commercial/assistant/ask";
import { getProfileByUserId } from "@/lib/auth/profile";
import { normalizeRole } from "@/lib/auth/roles";
import { isAdminEmail } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The assistant's endpoint.
 *
 * Behind the same access check as every commercial page — it is not open to
 * anyone with the URL. That check alone was never enough, though: the
 * assistant answers in prose from the same database the pages read, so it is a
 * second door onto every screen and has to carry the same locks.
 *
 * `assertCommercialAccess` answers "may this login use the platform at all",
 * which every sales rep passes. Its money lookups — the whole book's
 * outstanding and past due, the AR sheet, the purchase register, a job's
 * billed/collected/cost — return what `requireFinanceViewer` guards. So a rep
 * who could not open Accounting could ask what was on it, and the answer came
 * back in a sentence, which nobody cross-checks the way they check a tile.
 *
 * The role decides which lookups exist for this question. See MONEY_TOOLS.
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

  // Admin / account manager — the Accounting page's own predicate. The email
  // fallback covers an allowlist admin whose row has `is_admin` null.
  const profile = await getProfileByUserId(user.id);
  const role = normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(user.email));
  const canSeeMoney = role === "admin" || role === "account_manager";

  const res = await askAssistant(question, history, canSeeMoney);
  return NextResponse.json(res, { status: res.ok ? 200 : 200 });
}
