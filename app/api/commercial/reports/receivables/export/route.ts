import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { apiAccessDenied } from "@/lib/commercial/auth";
import { getReceivablesReport } from "@/lib/commercial/reports/receivables";
import { receivablesCsv, receivablesFilename } from "@/lib/commercial/reports/receivables-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The receivables sheet as a CSV — Mary's export.
 *
 * Same columns, same order, same total as the page, because it replaces the
 * spreadsheet she keeps by hand: if the export didn't tie out with the screen
 * she'd keep the spreadsheet and we'd have built nothing.
 *
 * The body is built by a shared helper rather than inline, so the file she
 * downloads and the file attached to Alex's email are byte-identical.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sb = commercialDb();
  const { data: prof } = await sb
    .from("profiles")
    .select("has_new_platform_access, is_active")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (await apiAccessDenied(auth.user.id, prof)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const report = await getReceivablesReport();
  return new NextResponse(receivablesCsv(report), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${receivablesFilename()}"`,
      "Cache-Control": "no-store",
    },
  });
}
