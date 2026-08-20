import "server-only";

import { sendEmail } from "@/lib/email/resend";
import { getReceivablesReport, type ReceivableRow } from "./receivables";
import { getCachedBrief } from "./receivables-brief";
import { AI_NOTE_MARK } from "./receivables-row-notes";
import { receivablesCsv, receivablesFilename } from "./receivables-export";
import { CSV_BOM } from "./export-guard";
import { etTodayIso } from "@/lib/date-et";

/**
 * Send the receivables sheet to Alex — the thing Mary does by hand today.
 *
 * Alex's ask (2026-08-19) was for the sheet in his inbox. So the email IS the
 * sheet: the figures, the rows, and the notes, readable on a phone without
 * opening anything. The CSV rides along as an attachment for the times he
 * wants to sort it, but the email is not a "click here to view" stub — a
 * notification that makes you open a laptop to learn the number has failed.
 *
 * The brief goes on top when one has been written, because that's the part he
 * asked for in words rather than columns.
 *
 * Recipient is env-overridable (same pattern as COMMERCIAL_PROPOSAL_COPY_EMAILS)
 * so this can be pointed at a test inbox before it ever reaches him, and so a
 * change of address is a Vercel setting rather than a deploy.
 */

const DEFAULT_TO = "alex@precisionpaintingplus.com";

/** Comma-separated override; falls back to Alex. */
export function receivablesRecipients(): string[] {
  const raw = (process.env.COMMERCIAL_RECEIVABLES_EMAIL || "").trim();
  const list = raw
    ? raw.split(",").map((s) => s.trim()).filter(Boolean)
    : [DEFAULT_TO];
  return list;
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function appendBase(relativePath: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
  return `${base}${relativePath}`;
}

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const KIND_LABEL: Record<ReceivableRow["kind"], string> = {
  invoice: "Invoice",
  aia: "AIA",
  retainage: "Retention",
};

function ageCell(r: ReceivableRow): string {
  if (r.kind === "retainage") return `<span style="color:#6b7280;">Held to close-out</span>`;
  if (r.daysOut === null) return `<span style="color:#6b7280;">No due date</span>`;
  if (r.daysOut > 0) return `<strong style="color:#b91c1c;">${r.daysOut}d late</strong>`;
  return `<span style="color:#6b7280;">Not yet due</span>`;
}

export async function sendReceivablesToAlex(): Promise<
  { ok: true; to: string[]; rowCount: number } | { ok: false; error: string }
> {
  let report = await getReceivablesReport();
  if (report.rows.length === 0) {
    return { ok: false, error: "Nothing is outstanding — there's no sheet to send." };
  }
  // Draft the silent rows before this goes out. "$3,135.00 · no note" tells
  // Alex nothing he can act on, and the facts that would are already on the
  // row. Best-effort and time-boxed: a slow or failed model call costs the
  // drafts, never the send.
  try {
    const { rowsNeedingNotes, generateRowNotes, withDraftedNotes } = await import(
      "./receivables-row-notes"
    );
    if (rowsNeedingNotes(report).some((r) => !r.aiNote)) {
      const drafted = await Promise.race([
        generateRowNotes(report),
        new Promise<{ ok: false; error: string }>((resolve) =>
          setTimeout(() => resolve({ ok: false, error: "timeout" }), 20_000)
        ),
      ]);
      if (drafted.ok) report = withDraftedNotes(report, drafted.notes);
    }
  } catch {
    // Notes are a nicety; the sheet is the point.
  }
  const { brief, stale } = await getCachedBrief(report);
  const to = receivablesRecipients();
  const today = etTodayIso();
  const link = appendBase("/commercial/reports/receivables");

  const rowsHtml = report.rows
    .map(
      (r, i) => `<tr style="background:${i % 2 ? "#fafafa" : "#fff"};">
  <td style="padding:8px 10px;border-bottom:1px solid #eee;">
    <div style="font-weight:600;color:#172B4D;">${escape(r.jobName)}</div>
    <div style="font-size:11px;color:#6b7280;">${escape(r.accountName)} · ${escape(KIND_LABEL[r.kind])} · ${escape(r.reference)}</div>
    ${
      r.note
        ? `<div style="font-size:11px;color:#6b7280;font-style:italic;margin-top:2px;">${escape(r.note)}</div>`
        : r.aiNote
          // Marked, quietly. Alex has to be able to tell what Mary knows from
          // what was worked out from the dates without the row shouting.
          ? `<div style="font-size:11px;color:#9ca3af;font-style:italic;margin-top:2px;"><span style="color:#EE662E;font-style:normal;">${AI_NOTE_MARK}</span> ${escape(r.aiNote)}</div>`
          : ""
    }
  </td>
  <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;font-weight:700;color:#172B4D;">${money(r.openCents)}</td>
  <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;font-size:11px;">${ageCell(r)}</td>
</tr>`
    )
    .join("\n");

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:680px;">
  <h2 style="margin:0 0 2px;font-size:18px;color:#172B4D;">Receivables — ${escape(today)}</h2>
  <p style="margin:0 0 16px;font-size:12px;color:#6b7280;">Every job with money out, invoices and AIA together, biggest first.</p>

  ${
    brief
      ? `<div style="margin:0 0 16px;padding:12px 14px;background:#fff7ed;border-left:4px solid #EE662E;border-radius:6px;">
    <div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#c2410c;margin-bottom:4px;">The brief</div>
    <div style="color:#333;">${escape(brief.text)}</div>
    ${stale ? `<div style="font-size:10px;color:#9ca3af;margin-top:6px;">Written before the latest changes.</div>` : ""}
  </div>`
      : ""
  }

  <table style="border-collapse:collapse;width:100%;margin:0 0 4px;">
    <tr>
      <td style="padding:10px 12px;background:#172B4D;color:#fff;border-radius:6px 0 0 6px;">
        <div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;opacity:.75;">Total outstanding</div>
        <div style="font-size:22px;font-weight:800;">${money(report.totalOpenCents)}</div>
      </td>
      <td style="padding:10px 12px;background:#172B4D;color:#fff;">
        <div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;opacity:.75;">Collectible now</div>
        <div style="font-size:22px;font-weight:800;">${money(report.dueNowCents)}</div>
      </td>
      <td style="padding:10px 12px;background:#172B4D;color:#fff;">
        <div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;opacity:.75;">Past due</div>
        <div style="font-size:22px;font-weight:800;">${money(report.overdueCents)}</div>
      </td>
      <td style="padding:10px 12px;background:#172B4D;color:#fff;border-radius:0 6px 6px 0;">
        <div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;opacity:.75;">Retention held</div>
        <div style="font-size:22px;font-weight:800;">${money(report.retainageCents)}</div>
      </td>
    </tr>
  </table>
  <p style="margin:0 0 16px;font-size:11px;color:#6b7280;">Retention is held until close-out — it is not late.</p>

  <table style="border-collapse:collapse;width:100%;font-size:13px;">
    <thead>
      <tr style="text-align:left;">
        <th style="padding:6px 10px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb;">Job</th>
        <th style="padding:6px 10px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb;text-align:right;">Billed / open</th>
        <th style="padding:6px 10px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb;text-align:right;">Status</th>
      </tr>
    </thead>
    <tbody>
${rowsHtml}
    </tbody>
  </table>

  <p style="margin:20px 0;"><a href="${link}" style="display:inline-block;padding:10px 18px;background:#EE662E;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Open the live report →</a></p>
  <p style="font-size:11px;color:#6b7280;">The same sheet is attached as a spreadsheet.</p>
  ${
    // A legend, only when there is something to explain — otherwise it's a
    // disclaimer on an email that doesn't need one.
    report.rows.some((r) => !r.note && r.aiNote)
      ? `<p style="font-size:11px;color:#9ca3af;margin-top:20px;"><span style="color:#EE662E;">${AI_NOTE_MARK}</span> Notes marked this way were drafted from the item's dates and figures — not written by anyone. Anything unmarked is a person's note.</p>`
      : ""
  }
  <p style="font-size:12px;color:#666;margin-top:28px;">— PPP Commercial Command Center</p>
</div>`;

  const text = [
    `Receivables — ${today}`,
    ``,
    brief ? `${brief.text}\n` : "",
    `Total outstanding:  ${money(report.totalOpenCents)}`,
    `Collectible now:    ${money(report.dueNowCents)}`,
    `Past due:           ${money(report.overdueCents)}`,
    `Retention held:     ${money(report.retainageCents)}  (held to close-out — not late)`,
    ``,
    ...report.rows.map(
      (r) =>
        `${money(r.openCents).padStart(12)}  ${r.jobName} — ${KIND_LABEL[r.kind]} ${r.reference}${
          r.daysOut !== null && r.daysOut > 0 ? ` (${r.daysOut}d late)` : ""
        }${r.note ? `\n              note: ${r.note}` : ""}`
    ),
    ``,
    `Open the live report: ${link}`,
    ``,
    `— PPP Commercial Command Center`,
  ]
    .filter((l) => l !== "")
    .join("\n");

  const res = await sendEmail({
    to,
    subject: `Receivables — ${money(report.totalOpenCents)} outstanding (${today})`,
    html,
    text,
    channel: "commercial",
    attachments: [
      {
        filename: receivablesFilename(),
        // BOM, same as every download: this attachment is opened in Excel
        // more often than anything else the platform produces, and without it
        // the "·" separators and em-dashes in job names arrive as mojibake.
        content: Buffer.from(CSV_BOM + receivablesCsv(report), "utf-8"),
      },
    ],
  });

  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, to, rowCount: report.rows.length };
}
