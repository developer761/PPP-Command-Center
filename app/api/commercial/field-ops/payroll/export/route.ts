import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { apiAccessDenied } from "@/lib/commercial/auth";
import { isAdminEmail } from "@/lib/auth/admin";
import { exportPayroll, redownloadPayroll } from "@/lib/commercial/field-ops/payroll";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/commercial/field-ops/payroll/export?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Streams the approved-time payroll CSV (W-2 only, reg/OT split). Admin-gated.
 */
async function handle(request: Request, mutating: boolean) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sb = commercialDb();
  const { data: profile } = await sb
    .from("profiles")
    .select("has_new_platform_access, is_active, is_admin")
    .eq("user_id", data.user.id)
    .maybeSingle();
  if ((await apiAccessDenied(data?.user?.id, profile))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  // Resolve admin EXACTLY as the payroll page does — `is_admin ?? isAdminEmail`.
  // The page falls back to the env allowlist; this route used to check the
  // column alone, so an allowlisted admin whose `profiles.is_admin` is still
  // NULL could open the page, see both Export buttons, and get a raw JSON 403
  // on click. Same shape as the labour-export gate mismatch fixed earlier.
  if (!((profile as { is_admin?: boolean | null } | null)?.is_admin ?? isAdminEmail(data.user.email))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return NextResponse.json({ error: "invalid_range" }, { status: 400 });
  }

  // ATOMIC: locks approved→exported FIRST, then builds the CSV from exactly the
  // rows that locked — no row can be paid-but-unlocked or locked-but-unpaid, and a
  // repeat export yields an empty CSV = "already paid" (audit rounds 6 + 12 + 13).
  // `?mode=redownload` re-issues an already-exported period without changing a
  // single status. The one-shot lock stays exactly as it was; this only stops
  // an interrupted download from losing the file for good.
  //
  // The LOCK is POST-only. It is a one-shot, irreversible state change with no
  // unlock path, and it used to sit behind a plain <a href>: a browser session
  // restore, a history revisit, or any link scanner following a URL pasted into
  // a chat would silently close a pay period. Every other mutation in this tree
  // is a POST; this one now matches.
  const redownload = searchParams.get("mode") === "redownload";
  if (!redownload && !mutating) {
    return NextResponse.json(
      { error: "use_post", detail: "Locking the pay period is a POST." },
      { status: 405, headers: { Allow: "POST" } }
    );
  }
  const csv = redownload
    ? await redownloadPayroll(from, to)
    : await exportPayroll(from, to, data.user.id);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="Payroll_${from}_to_${to}.csv"`,
    },
  });
}

/** Read-only: re-issues an already-exported period (`?mode=redownload`).
 *  A GET without that mode is refused — see the note in `handle`. */
export async function GET(request: Request) {
  return handle(request, false);
}

/** The locking export. Mutates: approved → exported, one shot. */
export async function POST(request: Request) {
  return handle(request, true);
}
