import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { apiAccessDenied } from "@/lib/commercial/auth";
import { getReceivablesReport } from "@/lib/commercial/reports/receivables";
import { receivablesCsv, receivablesFilename } from "@/lib/commercial/reports/receivables-export";
import {
  parseReceivableQuery,
  filtersFor,
  describeReceivableQuery,
  receivableAccountLabel,
} from "@/lib/commercial/reports/receivables-filters";

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
export async function GET(req: NextRequest) {
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

  // Same parser the page uses, so the file is exactly the slice on screen.
  const q = parseReceivableQuery((k) => req.nextUrl.searchParams.get(k));
  const report = await getReceivablesReport(Date.now(), filtersFor(q));
  const gcLabel = receivableAccountLabel(q, report.rows);
  return new NextResponse(receivablesCsv(report, describeReceivableQuery(q, gcLabel)), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${receivablesFilename(q.period, gcLabel)}"`,
      "Cache-Control": "no-store",
    },
  });
}
