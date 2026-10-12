import { NextResponse } from "next/server";
import { reportRecipients, sendDailyPaymentsReport } from "@/lib/payments/daily-report";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Daily, morning ET: yesterday's online payments, with the Excel file, to
 * PAYMENTS_REPORT_EMAILS. Off (does nothing) until that is set.
 *
 * Bearer-token auth via CRON_SECRET, like the other crons.
 */
export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected || request.headers.get("authorization") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const to = reportRecipients();
  if (to.length === 0) {
    return NextResponse.json({ ok: true, skipped: "PAYMENTS_REPORT_EMAILS is not set" });
  }
  try {
    const r = await sendDailyPaymentsReport(to);
    return NextResponse.json(r, { status: r.ok ? 200 : 500 });
  } catch (err) {
    console.error("[cron/payments-report]", err);
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
