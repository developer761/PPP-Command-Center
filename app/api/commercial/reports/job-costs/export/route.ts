import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { apiAccessDenied } from "@/lib/commercial/auth";
import { getJobCostsReport, COST_BUCKET_COLUMNS } from "@/lib/commercial/reports/job-costs";
import { opportunityStatusLabelV2 } from "@/lib/commercial/opportunities/constants";
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

  const report = await getJobCostsReport();

  // One row per deal, with every cost bucket broken out — so the finance team
  // can pivot in Excel. Ends with a company-wide TOTAL row.
  const bucketLabels = COST_BUCKET_COLUMNS.map((c) => c.label);
  const header = ["GC / account", "Deal", "Status", "Contract", "Billed", ...bucketLabels, "Total cost", "Margin", "Margin %"];
  const lines: string[] = [];
  for (const g of report.groups) {
    for (const d of g.deals) {
      lines.push(
        [
          g.accountName,
          d.dealName,
          opportunityStatusLabelV2(d.status),
          money(d.contractCents),
          money(d.billedCents),
          ...COST_BUCKET_COLUMNS.map((c) => money(d.buckets[c.key])),
          money(d.totalCostCents),
          money(d.marginCents),
          d.marginPct === null ? "" : String(d.marginPct),
        ].map(csv).join(","),
      );
    }
  }
  const t = report.totals;
  const totalRow = [
    "ALL",
    `${t.dealCount} deals · ${t.accountCount} GCs`,
    "",
    money(t.contractCents),
    money(t.billedCents),
    ...COST_BUCKET_COLUMNS.map((c) => money(t.buckets[c.key])),
    money(t.totalCostCents),
    money(t.marginCents),
    t.marginPct === null ? "" : String(t.marginPct),
  ].map(csv).join(",");

  const body = [header.map(csv).join(","), ...lines, totalRow].join("\r\n") + "\r\n";
  const today = etTodayIso();
  // Shared helper: consistent headers AND the UTF-8 BOM Excel needs.
  return csvResponse(body, `Job_Costs_${today}.csv`, "Job costs — cost against contract, by job");
}
