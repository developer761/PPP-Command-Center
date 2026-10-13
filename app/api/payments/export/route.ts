import { NextResponse } from "next/server";
import { getSignedInAdminEmail } from "@/lib/payments/access";
import { listLedgerPayments, paymentsConfig } from "@/lib/payments/service";
import { filterLedger, parseLedgerQuery, type LedgerPayment } from "@/lib/payments/ledger";
import { buildLedgerWorkbook } from "@/lib/payments/ledger-export";
import { etTodayIso } from "@/lib/date-et";

export const dynamic = "force-dynamic";

/**
 * GET /api/payments/export?range=…&with=…&mode=… — the Payments tab as .xlsx.
 * Same query-string parser as the page, so the file is what was on screen.
 */
export async function GET(request: Request) {
  if (!(await getSignedInAdminEmail())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const url = new URL(request.url);
  const today = etTodayIso();
  const q = parseLedgerQuery(Object.fromEntries(url.searchParams), today, paymentsConfig().stripeMode !== "test");
  const rows = filterLedger((await listLedgerPayments()) as LedgerPayment[], q);
  const buf = await buildLedgerWorkbook(rows, q);
  const name = `ppp-payments_${q.from ?? "start"}_to_${q.to ?? today}${q.livemode ? "" : "_TEST"}.xlsx`;
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
