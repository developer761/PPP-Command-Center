import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { apiAccessDenied } from "@/lib/commercial/auth";
import { getGeographyReport, type GeoRow } from "@/lib/commercial/reports/geography";
import { etTodayIso } from "@/lib/date-et";
import { csvEscape as csv } from "@/lib/commercial/csv";
import { csvResponse } from "@/lib/commercial/reports/export-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const geo = await getGeographyReport();
  const header = ["Grouping", "Location", "Detail", "Jobs", "Contract", "Total cost", "Margin", "Margin %"];
  const line = (grouping: string, r: GeoRow) =>
    [grouping, r.label, r.sub ?? "", r.dealCount, money(r.contractCents), money(r.totalCostCents), money(r.marginCents), r.marginPct === null ? "" : String(r.marginPct)]
      .map(csv)
      .join(",");
  const lines = [
    ...geo.byCity.map((r) => line("City", r)),
    ...geo.byZip.map((r) => line("Zip", r)),
    ...geo.byState.map((r) => line("State", r)),
  ];
  const body = [header.map(csv).join(","), ...lines].join("\r\n") + "\r\n";
  const today = etTodayIso();
  // Shared helper: consistent headers AND the UTF-8 BOM Excel needs.
  return csvResponse(body, `Geography_${today}.csv`);
}
