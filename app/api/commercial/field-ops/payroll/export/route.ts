import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { rawAccessDenied } from "@/lib/commercial/auth";
import { buildPayrollCsv } from "@/lib/commercial/field-ops/payroll";

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
    .select("has_new_platform_access, is_active, is_admin")
    .eq("user_id", data.user.id)
    .maybeSingle();
  if (rawAccessDenied(profile)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!(profile as { is_admin?: boolean } | null)?.is_admin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return NextResponse.json({ error: "invalid_range" }, { status: 400 });
  }

  const csv = await buildPayrollCsv(from, to);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="Payroll_${from}_to_${to}.csv"`,
    },
  });
}
