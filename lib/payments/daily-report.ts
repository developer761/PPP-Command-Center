import "server-only";

import { sendEmail } from "@/lib/email/resend";
import { etTodayIso } from "@/lib/date-et";
import { filterLedger, stageOf, type LedgerPayment, type LedgerQuery } from "@/lib/payments/ledger";
import { buildLedgerWorkbook } from "@/lib/payments/ledger-export";
import { monthStartIso, previousDayIso, renderDailyReport } from "@/lib/payments/daily-report-email";
import { listLedgerPayments, paymentsConfig } from "@/lib/payments/service";

/**
 * The daily online-payments email with the Excel file attached.
 *
 * Recipients come ONLY from PAYMENTS_REPORT_EMAILS (comma-separated) for the
 * scheduled send, or from the caller for "send a test to me". Nothing picks a
 * default audience — a recurring revenue report that can choose its own
 * recipients is one typo from reaching the wrong person.
 */
export function reportRecipients(): string[] {
  return (process.env.PAYMENTS_REPORT_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
}

function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://hub.precisionpaintingplus.net").replace(/\/$/, "");
}

/** `day` defaults to yesterday (ET) — the scheduled send. The admin "send to
 *  me" button can name another day, to see a day that had payments. */
export async function sendDailyPaymentsReport(
  to: string[],
  day: string = previousDayIso(etTodayIso()),
): Promise<{ ok: true; day: string; payments: number } | { ok: false; error: string }> {
  if (to.length === 0) return { ok: false, error: "No recipients." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, error: "Pick a date." };
  const livemode = paymentsConfig().stripeMode === "live";
  const all = (await listLedgerPayments()) as LedgerPayment[];
  const rows = filterLedger(all, { from: day, to: day, livemode });
  const monthRows = filterLedger(all, { from: monthStartIso(day), to: day, livemode });
  const failedCount = all.filter((p) => p.livemode === livemode && stageOf(p) === "booking_failed").length;

  const q: LedgerQuery = { preset: "custom", from: day, to: day, paidWith: "all", livemode };
  const tabUrl = `${appBaseUrl()}/dashboard/payments?range=month&mode=${livemode ? "live" : "test"}`;
  const { subject, text, html } = renderDailyReport({ day, rows, monthRows, failedCount, livemode, tabUrl });

  // No file on a day with nothing in it: an empty spreadsheet every quiet day
  // is an attachment people learn to stop opening.
  const attachments = rows.length
    ? [{ filename: `PPP-online-payments_${day}${livemode ? "" : "_TEST"}.xlsx`, content: await buildLedgerWorkbook(rows, q) }]
    : undefined;

  const res = await sendEmail({
    to,
    subject,
    text,
    html,
    attachments,
    tags: [{ name: "kind", value: "payments_daily_report" }],
  });
  return res.ok ? { ok: true, day, payments: rows.length } : { ok: false, error: res.error };
}
