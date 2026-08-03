import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { rawAccessDenied } from "@/lib/commercial/auth";
import { getArAging, type ArAgingRow } from "@/lib/commercial/reports/ar-aging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** CSV-escape a field (quote + double inner quotes when needed). */
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
  if (rawAccessDenied(prof)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const aging = await getArAging();
  const header = ["Customer", "Current", "1-30", "31-60", "61-90", "90+", "Total", "Open invoices", "Oldest days"];
  const line = (r: ArAgingRow) =>
    [r.accountName, money(r.current), money(r.d1_30), money(r.d31_60), money(r.d61_90), money(r.d90_plus), money(r.total), r.invoiceCount, Math.max(0, r.oldestDays)]
      .map(csv)
      .join(",");
  const totals = [
    "All customers",
    money(aging.totals.current),
    money(aging.totals.d1_30),
    money(aging.totals.d31_60),
    money(aging.totals.d61_90),
    money(aging.totals.d90_plus),
    money(aging.totals.total),
    aging.invoiceCount,
    "",
  ].map(csv).join(",");

  const body = [header.map(csv).join(","), ...aging.rows.map(line), totals].join("\r\n") + "\r\n";
  const today = new Date().toISOString().slice(0, 10);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="AR_Aging_${today}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
