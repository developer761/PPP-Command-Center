import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { apiAccessDenied } from "@/lib/commercial/auth";
import { exportPayroll, redownloadPayroll } from "@/lib/commercial/field-ops/payroll";
import { csvResponse } from "@/lib/commercial/reports/export-guard";
import { normalizeRole } from "@/lib/auth/roles";
import { isAdminEmail } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/commercial/field-ops/payroll/export?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Streams the approved-time payroll CSV (W-2 only, reg/OT split). Admin-gated.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sb = commercialDb();
  const { data: profile } = await sb
    .from("profiles")
    .select("has_new_platform_access, is_active, is_admin, role")
    .eq("user_id", data.user.id)
    .maybeSingle();
  if ((await apiAccessDenied(data?.user?.id, profile))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  /**
   * ADMIN **OR** ACCOUNT MANAGER — the same people predicate every other pay
   * surface uses.
   *
   * This read the raw `is_admin` boolean, so Mary (account_manager) could
   * enter per-employee payroll cost and post the whole week from Accounting,
   * and open the labor report and its per-person export — and then got a raw
   * JSON 403 on the payroll CSV. Same block also caught an env-allowlist admin
   * whose database row has `is_admin` null.
   */
  {
    const p = profile as { role?: string | null; is_admin?: boolean | null } | null;
    const role = normalizeRole(p?.role, p?.is_admin ?? isAdminEmail(data.user.email));
    if (role !== "admin" && role !== "account_manager") {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
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
  const redownload = searchParams.get("mode") === "redownload";
  const csv = redownload
    ? await redownloadPayroll(from, to)
    : await exportPayroll(from, to, data.user.id);

  // A header row with nothing under it is a SILENT failure: the browser saves
  // `Payroll_….csv`, the file opens empty, and nothing anywhere says whether
  // that means "already paid", "nothing approved" or "this company has no W-2
  // staff at all". Rows are joined with CRLF, so no CRLF = header only. Send
  // the operator back to the page with the reason instead of a blank file.
  if (!csv.includes("\r\n")) {
    const back = new URL("/commercial/field-ops/payroll", request.url);
    back.searchParams.set("from", from);
    back.searchParams.set("to", to);
    back.searchParams.set("empty", redownload ? "redownload" : "export");
    return NextResponse.redirect(back, { status: 303 });
  }

  // Shared helper: consistent headers AND the UTF-8 BOM Excel needs.
  return csvResponse(csv, `Payroll_${from}_to_${to}.csv`, "Payroll", `${from} to ${to}`);
}
