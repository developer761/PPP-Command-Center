import "server-only";

import { sendEmail } from "@/lib/email/resend";
import { getCommercialSetting, setCommercialSetting } from "@/lib/commercial/settings";
import { getReceivablesReport } from "./receivables";
import { getCachedBrief } from "./receivables-brief";
import { getTransactionsReport } from "./transactions";
import { getSalesTaxReport } from "./sales-tax";
import { getReimbursementsReport } from "./reimbursements";
import { listProjects, summarizeProduction } from "@/lib/commercial/projects/db";
import { getChangeOrderVendorReport } from "./change-orders-vendors";
import { receivablesRecipients } from "./receivables-email";
import { receivablesCsv } from "./receivables-export";
import { transactionsCsv } from "./transactions-export";
import { CSV_BOM, csvTitleBlock } from "./export-guard";
import { activityRange, changeOrderRange, weekStartOf } from "./presets";
import { etTodayIso } from "@/lib/date-et";

/**
 * THE DIGEST — everything, in Alex's inbox, on a cadence.
 *
 * Karan, 2026-08-19: *"we can send him a daily report of everything as well
 * along with a month and weekly with everything. But we need to get everything
 * 100 percent perfect before we do so."*
 *
 * Which is exactly the right order, and it is why this ships **off**. Every
 * cadence defaults to false, the cron sends nothing until somebody turns it on,
 * and there is a Preview that mails it to YOU rather than to him. A recurring
 * report to the CEO is not something to switch on and then start checking.
 *
 * One builder for all three cadences. A daily and a weekly that drift into
 * different definitions of "collected" is worse than not sending the weekly —
 * he would reconcile them against each other and lose trust in both. They
 * differ ONLY in the window and in what a window that size makes worth saying.
 */

export type DigestCadence = "daily" | "weekly" | "monthly";

export type DigestSettings = {
  daily: boolean;
  weekly: boolean;
  monthly: boolean;
};

const SETTINGS_KEY = "commercial_alex_digest";

/** Off until a person turns it on. */
export const DIGEST_DEFAULTS: DigestSettings = { daily: false, weekly: false, monthly: false };

export async function getDigestSettings(): Promise<DigestSettings> {
  const raw = await getCommercialSetting<Partial<DigestSettings>>(
    SETTINGS_KEY,
    {}
  ).catch((): Partial<DigestSettings> => ({}));
  return {
    daily: raw?.daily === true,
    weekly: raw?.weekly === true,
    monthly: raw?.monthly === true,
  };
}

export async function setDigestSettings(patch: Partial<DigestSettings>, userId: string): Promise<void> {
  const current = await getDigestSettings();
  await setCommercialSetting(SETTINGS_KEY, { ...current, ...patch }, userId);
}

/** The window each cadence reports on, as ET calendar dates. */
export function digestWindow(cadence: DigestCadence, todayYmd = etTodayIso()): { fromYmd: string; toYmd: string; label: string } {
  if (cadence === "daily") {
    return { fromYmd: todayYmd, toYmd: todayYmd, label: "today" };
  }
  if (cadence === "weekly") {
    // Monday-to-today, the same week the payroll and labour reports use. Two
    // definitions of "this week" in one platform is how a Sunday shift lands in
    // different weeks on different screens.
    return { fromYmd: weekStartOf(todayYmd), toYmd: todayYmd, label: "this week" };
  }
  const first = `${todayYmd.slice(0, 7)}-01`;
  return { fromYmd: first, toYmd: todayYmd, label: "this month" };
}

export type DigestData = {
  cadence: DigestCadence;
  windowLabel: string;
  fromYmd: string;
  toYmd: string;
  /** Whole-book figures — these are a position, not a period. */
  outstandingCents: number;
  collectibleCents: number;
  overdueCents: number;
  retainageCents: number;
  openItemCount: number;
  briefText: string | null;
  briefStale: boolean;
  /** Period figures. */
  inCents: number;
  outCents: number;
  netCents: number;
  txnCount: number;
  undepositedCents: number;
  undepositedCount: number;
  taxCollectedCents: number;
  uncertifiedCount: number;
  reimbursementsOwedCents: number;
  reimbursementsOwedCount: number;
  /** Position again — money earned that nobody has billed. */
  readyToBillCents: number;
  overBilledProjects: number;
};

export async function buildDigest(cadence: DigestCadence, todayYmd = etTodayIso()): Promise<DigestData> {
  const win = digestWindow(cadence, todayYmd);
  const range = { fromYmd: win.fromYmd, toYmd: win.toYmd };

  const [receivables, txns, tax, reimb, projects, coVendor] = await Promise.all([
    // WHOLE book, deliberately: what is owed is a position, and narrowing it to
    // a day would make "outstanding" mean something different every morning.
    getReceivablesReport(),
    getTransactionsReport(range),
    getSalesTaxReport(range),
    getReimbursementsReport(range),
    listProjects(),
    getChangeOrderVendorReport(changeOrderRange("this_year")),
  ]);
  const production = summarizeProduction(projects);
  const { brief, stale } = await getCachedBrief(receivables);

  return {
    cadence,
    windowLabel: win.label,
    fromYmd: win.fromYmd,
    toYmd: win.toYmd,
    outstandingCents: receivables.totalOpenCents,
    collectibleCents: receivables.dueNowCents,
    overdueCents: receivables.overdueCents,
    retainageCents: receivables.retainageCents,
    openItemCount: receivables.rows.length,
    briefText: brief?.text ?? null,
    briefStale: stale,
    inCents: txns.inCents,
    outCents: txns.outCents,
    netCents: txns.netCents,
    txnCount: txns.rowCount,
    undepositedCents: txns.undepositedCents,
    undepositedCount: txns.undepositedCount,
    taxCollectedCents: tax.taxCollectedCents,
    uncertifiedCount: tax.uncertifiedCount,
    reimbursementsOwedCents: reimb.owedCents,
    reimbursementsOwedCount: reimb.owed.length,
    // Same clamped definition the Accounting page uses — never Σcontract−Σbilled.
    readyToBillCents: production.leftToBillCents + coVendor.co.unbilledCents,
    overBilledProjects: production.overBilledProjects,
  };
}

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function appendBase(path: string): string {
  return `${(process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "")}${path}`;
}

const TITLE: Record<DigestCadence, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

/** The email. Figures first, prose second — he reads this on a phone. */
export function renderDigestEmail(d: DigestData): { subject: string; text: string; html: string } {
  const subject = `${TITLE[d.cadence]} · ${money(d.outstandingCents)} outstanding${d.overdueCents > 0 ? `, ${money(d.overdueCents)} late` : ""}`;

  // Only the lines worth his attention. A digest that always says the same
  // eight things stops being read by the second week.
  const flags: string[] = [];
  if (d.overdueCents > 0) flags.push(`${money(d.overdueCents)} is past due.`);
  if (d.undepositedCount > 0)
    flags.push(`${money(d.undepositedCents)} received but not deposited (${d.undepositedCount}).`);
  if (d.readyToBillCents > 0) flags.push(`${money(d.readyToBillCents)} is earned and not yet billed.`);
  if (d.reimbursementsOwedCount > 0)
    flags.push(`${money(d.reimbursementsOwedCents)} owed back to people (${d.reimbursementsOwedCount}).`);
  if (d.uncertifiedCount > 0)
    flags.push(`${d.uncertifiedCount} exempt invoice${d.uncertifiedCount === 1 ? "" : "s"} with no certificate on file.`);
  if (d.overBilledProjects > 0)
    flags.push(`${d.overBilledProjects} job${d.overBilledProjects === 1 ? " is" : "s are"} billed past contract.`);

  const link = appendBase("/commercial/accounting");

  const text = [
    `${TITLE[d.cadence]} report — ${d.fromYmd}${d.fromYmd === d.toYmd ? "" : ` to ${d.toYmd}`}`,
    ``,
    `OWED TO US`,
    `  Outstanding      ${money(d.outstandingCents)}  (${d.openItemCount} open items)`,
    `  Collectible now  ${money(d.collectibleCents)}`,
    `  Past due         ${money(d.overdueCents)}`,
    `  Retention held   ${money(d.retainageCents)}`,
    ``,
    `MONEY ${d.windowLabel.toUpperCase()}`,
    `  In               ${money(d.inCents)}`,
    `  Out              ${money(d.outCents)}`,
    `  Net              ${money(d.netCents)}   (${d.txnCount} transactions)`,
    `  Not deposited    ${money(d.undepositedCents)}`,
    `  Sales tax        ${money(d.taxCollectedCents)}`,
    ``,
    ...(flags.length ? [`WORTH A LOOK`, ...flags.map((f) => `  · ${f}`), ``] : []),
    ...(d.briefText ? [`THE BRIEF`, d.briefText, ``] : []),
    `Open the money desk: ${link}`,
    ``,
    `— PPP Commercial Command Center`,
  ].join("\n");

  const tile = (label: string, value: string, sub?: string) => `
      <td style="padding:10px 12px;background:#172B4D;color:#fff;">
        <div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;opacity:.75;">${escape(label)}</div>
        <div style="font-size:20px;font-weight:800;">${escape(value)}</div>
        ${sub ? `<div style="font-size:10px;opacity:.6;">${escape(sub)}</div>` : ""}
      </td>`;

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:680px;">
  <h2 style="margin:0 0 2px;font-size:18px;color:#172B4D;">${escape(TITLE[d.cadence])} report</h2>
  <p style="margin:0 0 16px;font-size:12px;color:#6b7280;">${escape(d.fromYmd)}${d.fromYmd === d.toYmd ? "" : ` to ${escape(d.toYmd)}`}</p>

  <table style="border-collapse:collapse;width:100%;margin:0 0 6px;"><tr>
    ${tile("Outstanding", money(d.outstandingCents), `${d.openItemCount} open items`)}
    ${tile("Collectible now", money(d.collectibleCents), "excludes retention")}
    ${tile("Past due", money(d.overdueCents), d.overdueCents > 0 ? "chase these" : "nothing late")}
    ${tile("Retention held", money(d.retainageCents), "at close-out")}
  </tr></table>

  <table style="border-collapse:collapse;width:100%;margin:0 0 16px;"><tr>
    ${tile(`In ${d.windowLabel}`, money(d.inCents), `${d.txnCount} transactions`)}
    ${tile(`Out ${d.windowLabel}`, money(d.outCents))}
    ${tile("Net", money(d.netCents))}
    ${tile("Not deposited", money(d.undepositedCents), `${d.undepositedCount} payments`)}
  </tr></table>

  ${
    flags.length
      ? `<div style="margin:0 0 16px;padding:12px 14px;background:#fffbeb;border-left:4px solid #f59e0b;border-radius:6px;">
    <div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#b45309;margin-bottom:6px;">Worth a look</div>
    <ul style="margin:0;padding-left:18px;color:#333;">${flags.map((f) => `<li>${escape(f)}</li>`).join("")}</ul>
  </div>`
      : `<p style="margin:0 0 16px;color:#047857;">Nothing needs attention — nothing late, nothing unbilled, nothing sitting undeposited.</p>`
  }

  ${
    d.briefText
      ? `<div style="margin:0 0 16px;padding:12px 14px;background:#fff7ed;border-left:4px solid #EE662E;border-radius:6px;">
    <div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#c2410c;margin-bottom:4px;">The brief</div>
    <div style="color:#333;">${escape(d.briefText)}</div>
    ${d.briefStale ? `<div style="font-size:10px;color:#9ca3af;margin-top:6px;">Written before the latest changes.</div>` : ""}
  </div>`
      : ""
  }

  <p style="margin:20px 0;"><a href="${link}" style="display:inline-block;padding:11px 20px;background:#EE662E;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Open the money desk &rarr;</a></p>
  <p style="font-size:12px;color:#666;margin-top:28px;">— PPP Commercial Command Center</p>
</div>`;

  return { subject, text, html };
}

/**
 * Send one digest.
 *
 * `to` is explicit so the Preview button can address it to whoever pressed it.
 * Nothing here reads a default recipient — a recurring report that can pick its
 * own audience is one send away from reaching the wrong person.
 */
export async function sendDigest(
  cadence: DigestCadence,
  to: string[]
): Promise<{ ok: true; to: string[] } | { ok: false; error: string }> {
  if (to.length === 0) return { ok: false, error: "No recipient." };
  try {
    const data = await buildDigest(cadence);
    const { subject, text, html } = renderDigestEmail(data);

    // Two sheets ride along: what's owed, and what moved in the window. The
    // email answers "where do we stand" on a phone; the attachments are for
    // the times he wants to sort or forward one. Same builders as the
    // downloads — a figure he checks against the app has to match it — and
    // BOM-prefixed, because these are opened in Excel.
    const [rawReceivables, txns] = await Promise.all([
      getReceivablesReport(),
      getTransactionsReport({ fromYmd: data.fromYmd, toYmd: data.toYmd }),
    ]);
    // Bring the AI reads up to date before the sheet goes out. The SCHEDULED
    // report is the one place they matter most and the one place nobody is
    // sitting there to press a button — so it refreshes itself, time-boxed, and
    // sends whatever is already cached if the model is slow or down.
    const { ensureRowNotes } = await import("./receivables-row-notes");
    const receivables = await ensureRowNotes(rawReceivables);
    const stamp = data.toYmd;
    const attachments = [
      {
        filename: `Receivables_${stamp}.csv`,
        content: Buffer.from(
          CSV_BOM + csvTitleBlock("Receivables — every job with money out") + receivablesCsv(receivables),
          "utf-8"
        ),
      },
      // Only when there is something in it. An empty ledger attached to every
      // daily email is an attachment people stop opening.
      ...(txns.rowCount > 0
        ? [
            {
              filename: `Transactions_${stamp}.csv`,
              content: Buffer.from(
                CSV_BOM +
                  csvTitleBlock("Transactions — money in and out, by month", data.windowLabel) +
                  transactionsCsv(txns),
                "utf-8"
              ),
            },
          ]
        : []),
    ];

    const res = await sendEmail({
      to,
      subject,
      text,
      html,
      channel: "commercial",
      attachments,
      tags: [{ name: "kind", value: `commercial_digest_${cadence}` }],
    });
    return res.ok ? { ok: true, to } : { ok: false, error: "The email didn't send. Try again." };
  } catch (err) {
    console.error("[alex-digest] send failed:", err);
    return { ok: false, error: "Couldn't build the report just now." };
  }
}

/**
 * The cron entry point — which cadences are due today, and are they even on?
 *
 * Weekly fires on Monday, monthly on the 1st, and both ride the SAME daily cron
 * as everything else. Hobby allows one cron; asking for two more to send two
 * more emails would be a poor trade for a schedule this simple.
 */
export async function runAlexDigests(todayYmd = etTodayIso()): Promise<{
  ok: boolean;
  found: number;
  sent: number;
  skipped: number;
  errors: string[];
}> {
  const out = { ok: true, found: 0, sent: 0, skipped: 0, errors: [] as string[] };
  try {
    const settings = await getDigestSettings();
    // Nothing is on by default, so a fresh environment sends nothing at all
    // until a person decides it should.
    if (!settings.daily && !settings.weekly && !settings.monthly) return out;

    const dow = new Date(`${todayYmd}T12:00:00Z`).getUTCDay(); // 1 = Monday
    const dom = Number(todayYmd.slice(8, 10));
    const due: DigestCadence[] = [];
    if (settings.daily) due.push("daily");
    if (settings.weekly && dow === 1) due.push("weekly");
    if (settings.monthly && dom === 1) due.push("monthly");
    out.found = due.length;
    if (due.length === 0) return out;

    const to = receivablesRecipients();
    for (const cadence of due) {
      const res = await sendDigest(cadence, to);
      if (res.ok) out.sent += 1;
      else {
        out.skipped += 1;
        out.errors.push(`${cadence}: ${res.error}`);
      }
    }
    return out;
  } catch (err) {
    out.ok = false;
    out.errors.push(err instanceof Error ? err.message : String(err));
    return out;
  }
}

/** Exported for the settings UI so it can describe the window without guessing. */
export { activityRange };
