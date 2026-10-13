import { formatCents } from "@/lib/payments/schedule";
import {
  PAID_WITH_LABEL,
  STAGE_LABEL,
  paidWith,
  stageOf,
  totalsOf,
  type LedgerPayment,
} from "@/lib/payments/ledger";

/**
 * The daily online-payments email: yesterday's payments, month to date, and
 * anything that needs someone. The Excel file rides along (built elsewhere,
 * by the same builder as the Payments tab's Export, so the numbers match).
 *
 * Pure — no clock, no I/O — so the wording and arithmetic are testable.
 */

/** "2026-10-12" → "2026-10-11". Calendar arithmetic, no time zone involved. */
export function previousDayIso(dayIso: string): string {
  const [y, m, d] = dayIso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

export function monthStartIso(dayIso: string): string {
  return `${dayIso.slice(0, 7)}-01`;
}

/** "2026-10-11" → "Sunday, Oct 11". */
export function longDay(dayIso: string): string {
  const [y, m, d] = dayIso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type DailyReportInput = {
  /** The day reported on (ET), YYYY-MM-DD. */
  day: string;
  /** Payments made on `day`. */
  rows: LedgerPayment[];
  /** Payments from the 1st of the month through `day`. */
  monthRows: LedgerPayment[];
  /** Payments in any period whose Salesforce booking failed. */
  failedCount: number;
  livemode: boolean;
  /** Where "Open the Payments tab" points. */
  tabUrl: string;
};

export function renderDailyReport(i: DailyReportInput): { subject: string; text: string; html: string } {
  const t = totalsOf(i.rows);
  const m = totalsOf(i.monthRows);
  const dayText = longDay(i.day);
  const test = i.livemode ? "" : "[TEST] ";
  const subject =
    t.count > 0
      ? `${test}Online payments ${dayText}: ${formatCents(t.baseCents)} (${t.count})`
      : `${test}Online payments ${dayText}: none`;

  const sorted = [...i.rows].sort((a, b) => (a.customer_name ?? "").localeCompare(b.customer_name ?? ""));

  // ── plain text ──
  const lines: string[] = [];
  if (!i.livemode) lines.push("STRIPE TEST MODE — not real money.", "");
  if (t.count === 0) lines.push(`No online payments on ${dayText}.`);
  else {
    lines.push(
      `${dayText}: ${t.count} payment${t.count === 1 ? "" : "s"}`,
      `  Collected (to Salesforce): ${formatCents(t.baseCents)}`,
      `  Card fees (3% credit):     ${formatCents(t.feeCents)}`,
      `  Total charged:             ${formatCents(t.totalCents)}`,
      "",
    );
    for (const p of sorted) {
      lines.push(
        `  ${p.customer_name ?? "—"} · WO ${p.work_order_number} · ${p.milestone_label} · ${PAID_WITH_LABEL[paidWith(p)]} · ${formatCents(p.base_cents)}${p.fee_cents ? ` + ${formatCents(p.fee_cents)} fee` : ""} · ${STAGE_LABEL[stageOf(p)]}`,
      );
    }
  }
  lines.push(
    "",
    `Month to date: ${m.count} payment${m.count === 1 ? "" : "s"} · ${formatCents(m.baseCents)} collected · ${formatCents(m.feeCents)} card fees`,
  );
  if (i.failedCount > 0) {
    lines.push("", `NEEDS ATTENTION: ${i.failedCount} payment${i.failedCount === 1 ? "" : "s"} didn't book in Salesforce.`);
  }
  if (t.count > 0) lines.push("", "The Excel file is attached.");
  lines.push("", `Payments tab: ${i.tabUrl}`);

  // ── html ──
  const td = "padding:6px 8px;border-bottom:1px solid #e5e7eb;font-size:13px;color:#172B4D;";
  const tdR = `${td}text-align:right;white-space:nowrap;`;
  const stat = (label: string, value: string) =>
    `<td style="padding:0 20px 0 0;vertical-align:top"><div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em">${label}</div><div style="font-size:20px;font-weight:700;color:#172B4D">${value}</div></td>`;

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f7f7f8;font-family:Roboto,Arial,sans-serif">
<div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">
${!i.livemode ? `<div style="margin:0 0 16px;padding:8px 12px;border-radius:8px;background:#fdefe5;color:#9a3a10;font-size:13px"><strong>Stripe test mode</strong> — not real money.</div>` : ""}
<div style="font-size:12px;color:#6b7280">Online payments</div>
<div style="font-size:20px;font-weight:700;color:#172B4D;margin:2px 0 16px">${esc(dayText)}</div>
${
  t.count === 0
    ? `<p style="font-size:14px;color:#374151;margin:0 0 16px">No online payments on this day.</p>`
    : `<table role="presentation" style="border-collapse:collapse;margin:0 0 20px"><tr>${stat("Collected", formatCents(t.baseCents))}${stat("Card fees", formatCents(t.feeCents))}${stat("Total charged", formatCents(t.totalCents))}</tr></table>
<table style="border-collapse:collapse;width:100%;margin:0 0 20px">
<tr><th style="${td}text-align:left;color:#6b7280;font-weight:500">Customer</th><th style="${td}text-align:left;color:#6b7280;font-weight:500">Term</th><th style="${td}text-align:left;color:#6b7280;font-weight:500">Method</th><th style="${tdR}color:#6b7280;font-weight:500">Amount</th></tr>
${sorted
  .map(
    (p) =>
      `<tr><td style="${td}"><strong>${esc(p.customer_name ?? "—")}</strong><br><span style="color:#6b7280;font-size:12px">WO ${esc(p.work_order_number)} · ${esc(STAGE_LABEL[stageOf(p)])}</span></td><td style="${td}">${esc(p.milestone_label)}</td><td style="${td}">${esc(PAID_WITH_LABEL[paidWith(p)])}</td><td style="${tdR}"><strong>${formatCents(p.base_cents)}</strong>${p.fee_cents ? `<br><span style="color:#b4501f;font-size:12px">+ ${formatCents(p.fee_cents)} fee</span>` : ""}</td></tr>`,
  )
  .join("\n")}
</table>`
}
<p style="font-size:13px;color:#374151;margin:0 0 8px"><strong>Month to date:</strong> ${m.count} payment${m.count === 1 ? "" : "s"} · ${formatCents(m.baseCents)} collected · ${formatCents(m.feeCents)} card fees</p>
${
  i.failedCount > 0
    ? `<p style="font-size:13px;margin:12px 0 8px;padding:8px 12px;border-radius:8px;background:#fef2f2;color:#991b1b"><strong>Needs attention:</strong> ${i.failedCount} payment${i.failedCount === 1 ? "" : "s"} didn't book in Salesforce.</p>`
    : ""
}
${t.count > 0 ? `<p style="font-size:13px;color:#374151;margin:12px 0 8px">The Excel file is attached.</p>` : ""}
<p style="margin:20px 0 0"><a href="${esc(i.tabUrl)}" style="display:inline-block;background:#172B4D;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 16px;border-radius:8px">Open the Payments tab</a></p>
</div></body></html>`;

  return { subject, text: lines.join("\n"), html };
}
