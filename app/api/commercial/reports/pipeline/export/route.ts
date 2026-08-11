import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { apiAccessDenied } from "@/lib/commercial/auth";
import { getPipelineReport } from "@/lib/commercial/reports/pipeline";
import { etTodayIso } from "@/lib/date-et";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function csv(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const money = (cents: number) => (cents / 100).toFixed(2);

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
  if ((await apiAccessDenied(auth?.user?.id, prof))) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const report = await getPipelineReport();
  const header = ["Stage", "Opportunities", "Bid value", "Weighted value"];
  const lines = report.rows.map((r) => [r.label, r.count, money(r.bidCents), money(r.weightedCents)].map(csv).join(","));
  const totals = ["All open", report.totals.count, money(report.totals.bidCents), money(report.totals.weightedCents)].map(csv).join(",");
  const body = [header.map(csv).join(","), ...lines, totals].join("\r\n") + "\r\n";
  const today = etTodayIso();
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="Pipeline_${today}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
