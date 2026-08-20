import type { NextRequest } from "next/server";
import { csvEscape as csv } from "@/lib/commercial/csv";
import { getChangeOrderVendorReport } from "@/lib/commercial/reports/change-orders-vendors";
import { CHANGE_ORDER_PRESETS, CHANGE_ORDER_DEFAULT, changeOrderRange, resolvePreset } from "@/lib/commercial/reports/presets";
import { guardExport, csvResponse } from "@/lib/commercial/reports/export-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const money = (c: number) => (c / 100).toFixed(2);

/** Change orders & vendor spend. */
export async function GET(req: NextRequest) {
  const guard = await guardExport();
  if (!guard.ok) return guard.response;

  const preset = resolvePreset(
    req.nextUrl.searchParams.get("preset") ?? undefined,
    CHANGE_ORDER_PRESETS,
    CHANGE_ORDER_DEFAULT
  );
  const range = changeOrderRange(preset);
  const r = await getChangeOrderVendorReport(range);

  const L: string[] = [];
  const row = (...cells: (string | number)[]) => L.push(cells.map(csv).join(","));

  row("Change orders & vendor spend", range.label, `${range.fromYmd} to ${range.toYmd}`);
  row("");
  row("CHANGE ORDERS");
  row("Raised", r.co.raised);
  row("Approved", r.co.approved.count, money(r.co.approved.cents));
  row("Declined", r.co.declined.count, money(r.co.declined.cents));
  row("Pending", r.co.pending.count, money(r.co.pending.cents));
  // Adds and deducts stay apart: netting them hides how much scope was added.
  row("Approved adds", "", money(r.co.approvedAddCents));
  row("Approved deducts", "", money(r.co.approvedDeductCents));
  row("Approval rate %", r.co.approvalRatePct ?? "");
  row("Avg days to decide", r.co.avgDaysToDecide ?? "", `over ${r.co.decidedSample} decided`);
  // Money agreed and never asked for — the line worth acting on.
  row("Approved, not yet billed", r.co.unbilledCount, money(r.co.unbilledCents));
  row("Approved credits not billed back", r.co.unbilledCreditCount, money(r.co.unbilledCreditCents));
  row("");

  row("BY GC");
  row("GC", "Approved", "Approved adds", "Approved deducts", "Pending", "Declined");
  for (const a of r.co.byAccount) {
    row(a.accountName, a.approvedCount, money(a.approvedAddCents), money(a.approvedDeductCents), a.pendingCount, a.declinedCount);
  }
  row("");

  row("VENDOR SPEND");
  row("Total", money(r.vendorTotalCents));
  row("Vendor", "Spend", "Purchases", "Top category", "Name variants merged");
  for (const v of r.vendors) row(v.name, money(v.cents), v.count, v.topCategory, v.variants);
  row("");

  row("BY CATEGORY");
  row("Category", "Spend", "Purchases");
  for (const c of r.categories) row(c.label, money(c.cents), c.count);

  if (r.unattributedCount > 0) {
    row("");
    row("DATA NOTES");
    row("Purchases with no vendor recorded (not in the vendor table above)", r.unattributedCount, money(r.unattributedCents));
  }

  return csvResponse(L.join("\r\n") + "\r\n", `Change_Orders_Vendors_${range.fromYmd}_to_${range.toYmd}.csv`);
}
