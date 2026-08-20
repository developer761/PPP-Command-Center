import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { apiAccessDenied } from "@/lib/commercial/auth";
import { getGeographyReport, type GeoRow } from "@/lib/commercial/reports/geography";
import { etTodayIso } from "@/lib/date-et";
import { csvEscape as csv } from "@/lib/commercial/csv";

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
  // The three groupings are the SAME deals counted three ways - the page keeps
  // them in three separate tables, and stacking them into one sheet means an
  // AutoSum down the Contract column returns roughly 3x the real figure. So the
  // file leads with the true portfolio totals, and every detail row is labelled
  // with its grouping, before any of them appear.
  //
  // `unspecifiedCount` comes with it: the page warns that deals with no site
  // address are counted in the totals but can't be placed. Without that line the
  // located-only rows below can't be reconciled against the Contract value, and
  // the gap reads as missing money instead of missing addresses.
  const t = geo.totals;
  const summary = [
    ["Geography", `${t.dealCount} opportunities`].map(csv).join(","),
    ["Contract value (all opportunities)", money(t.contractCents)].map(csv).join(","),
    ["Located opportunities", String(t.locatedCount)].map(csv).join(","),
    [
      "No site address",
      String(t.unspecifiedCount),
      t.unspecifiedCount > 0 ? "counted in the total above, absent from the rows below" : "",
    ]
      .map(csv)
      .join(","),
    "",
    ["NOTE", "City / Zip / State are three views of the same opportunities - do not sum across groupings"]
      .map(csv)
      .join(","),
    "",
  ];
  const lines = [
    ...geo.byCity.map((r) => line("City", r)),
    ...geo.byZip.map((r) => line("Zip", r)),
    ...geo.byState.map((r) => line("State", r)),
  ];
  const body = [...summary, header.map(csv).join(","), ...lines].join("\r\n") + "\r\n";
  const today = etTodayIso();
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="Geography_${today}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
