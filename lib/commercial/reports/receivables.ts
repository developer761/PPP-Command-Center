import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { listCommercialInvoices } from "@/lib/commercial/invoices/db";
import { deriveInvoiceStatus, DEFAULT_DUE_DAYS } from "@/lib/commercial/invoices/constants";
import { listCommercialOpportunities, derivedOppName } from "@/lib/commercial/opportunities/db";
import { aiaBillingRollupBulk } from "@/lib/commercial/aia/db";
import { daysPastDue } from "./ar-aging";

/**
 * The RECEIVABLES report — Alex's ask, 2026-08-19, modelled on the sheet Mary
 * builds by hand: *"all jobs we have invoiced completed or progress."*
 *
 * Mary's sheet is three columns — Job · Billed/Open · Notes — one row per open
 * item, totalling ~$245k. It is deliberately NOT the existing AR-aging report:
 * that one buckets by days overdue for collections triage. This one is the
 * chase list, and its most valuable column is the one a machine can't produce —
 * "8/19/26 asked for update", "s/b paid within 2 weeks".
 *
 * The point of building it: most of what Mary types by hand is data we already
 * hold. "AIA#3-7/22/26" is an application number and its issue date. "Retention"
 * is a field. So the reference column generates itself and she only writes the
 * genuinely human part — which is also the part that stops being lost when
 * whoever keeps the spreadsheet is on holiday.
 *
 * Retention is included as its own row, flagged, because Mary tracks it in the
 * same list and her total includes it. It is still called out separately in the
 * summary, because retainage is not collectible the way an overdue invoice is
 * (see aiaBilledCollectedFrom for why that distinction is load-bearing).
 */

export type ReceivableKind = "invoice" | "aia" | "retainage";

export type ReceivableRow = {
  kind: ReceivableKind;
  /** Stable key for the notes store: `${kind}:${sourceId}`. */
  key: string;
  sourceId: string;
  accountId: string;
  accountName: string;
  /** Mary's "Job" column. */
  jobName: string;
  /** Mary's "Billed/Open". */
  openCents: number;
  /** Auto-generated — what Mary hand-types as "AIA#3-7/22/26". */
  reference: string;
  /** The human column. Null until somebody writes one. */
  note: string | null;
  issuedIso: string | null;
  /** Days past due. Null when there's no due date (retainage never ages). */
  daysOut: number | null;
  href: string;
};

export type ReceivablesReport = {
  rows: ReceivableRow[];
  /** Everything outstanding, retention included — matches Mary's total. */
  totalOpenCents: number;
  /** The slice of that which is retention, held to close-out. */
  retainageCents: number;
  /** Currently collectible: total minus retention. */
  dueNowCents: number;
  overdueCents: number;
  generatedAt: string;
};

function fmtRefDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "numeric",
    day: "numeric",
    year: "2-digit",
  });
}

export async function getReceivablesReport(nowMs = Date.now()): Promise<ReceivablesReport> {
  const [invoices, opps] = await Promise.all([
    listCommercialInvoices({}),
    // includeArchived: archiving a deal is a tidy-up, not a write-off — the
    // money is still owed. Same rule the AR-aging report and the dashboard
    // "Owed to us" tile settled on.
    listCommercialOpportunities({ includeArchived: true }),
  ]);
  const oppById = new Map(opps.map((o) => [o.id, o] as const));

  // GC names in one query.
  const acctIds = [...new Set(opps.map((o) => o.account_id))];
  const nameById = new Map<string, string>();
  if (acctIds.length > 0) {
    const sb = commercialDb();
    const { data } = await sb
      .from("commercial_accounts")
      .select("id, company_name")
      .in("id", acctIds);
    for (const a of (data ?? []) as { id: string; company_name: string | null }[]) {
      nameById.set(a.id, a.company_name ?? "—");
    }
  }
  const jobNameFor = (oppId: string | null): { job: string; accountId: string; account: string } => {
    const o = oppId ? oppById.get(oppId) : null;
    const accountId = o?.account_id ?? "";
    const account = nameById.get(accountId) ?? "—";
    return { job: o ? derivedOppName(o, account) : "Account-level", accountId, account };
  };

  const rows: ReceivableRow[] = [];

  // ── Invoices ────────────────────────────────────────────────────────────
  for (const inv of invoices) {
    const status = deriveInvoiceStatus(inv);
    if (status === "draft" || status === "void") continue;
    const open = Math.max(0, inv.balance_cents);
    if (open <= 0) continue;
    // An invoice on a deal that was deleted (or whose account was) is gone from
    // the app and must be gone from the chase list too.
    if (inv.opportunity_id && !oppById.has(inv.opportunity_id)) continue;
    const { job, accountId, account } = jobNameFor(inv.opportunity_id);
    const issued = inv.issued_at ?? null;
    rows.push({
      kind: "invoice",
      key: `invoice:${inv.id}`,
      sourceId: inv.id,
      accountId,
      accountName: account,
      jobName: job,
      openCents: open,
      reference: [inv.invoice_number, issued ? `sent ${fmtRefDate(issued)}` : null]
        .filter(Boolean)
        .join(" · "),
      note: inv.notes?.trim() || null,
      issuedIso: issued,
      daysOut: inv.due_at ? daysPastDue(inv.due_at, nowMs) : null,
      href: `/commercial/invoices/${inv.id}`,
    });
  }

  // ── AIA applications ────────────────────────────────────────────────────
  // These write no invoice row, so without this the biggest receivables in the
  // book are simply absent — which is exactly what Mary's sheet is full of.
  const rollups = await aiaBillingRollupBulk(opps.map((o) => o.id));
  for (const [oppId, roll] of rollups) {
    const { job, accountId, account } = jobNameFor(oppId);
    const issuedIso =
      roll.latestIssuedFrozenAt ??
      (roll.latestIssuedPeriodTo ? `${roll.latestIssuedPeriodTo}T16:00:00Z` : null);

    if (roll.dueNowCents > 0) {
      const dueAt = issuedIso
        ? new Date(new Date(issuedIso).getTime() + DEFAULT_DUE_DAYS * 86_400_000).toISOString()
        : null;
      rows.push({
        kind: "aia",
        key: `aia:${roll.latestIssuedId}`,
        sourceId: roll.latestIssuedId,
        accountId,
        accountName: account,
        jobName: job,
        openCents: roll.dueNowCents,
        // Mary writes this by hand as "AIA#3-7/22/26". Same thing, generated.
        reference: `AIA #${roll.latestIssuedNumber}${issuedIso ? ` · sent ${fmtRefDate(issuedIso)}` : ""}`,
        note: null,
        issuedIso,
        daysOut: dueAt ? daysPastDue(dueAt, nowMs) : null,
        href: `/commercial/opportunities/${oppId}?tab=aia&app=${roll.latestIssuedId}`,
      });
    }

    // Retention as its own row — Mary lists it separately and Alex's total
    // includes it. Never given a due date: it isn't late, it's held.
    if (roll.retainageHeldCents > 0) {
      rows.push({
        kind: "retainage",
        key: `retainage:${oppId}`,
        sourceId: oppId,
        accountId,
        accountName: account,
        jobName: job,
        openCents: roll.retainageHeldCents,
        reference: `Retention · AIA #${roll.latestIssuedNumber}`,
        note: null,
        issuedIso,
        daysOut: null,
        href: `/commercial/opportunities/${oppId}?tab=aia`,
      });
    }
  }

  // ── Collection notes ────────────────────────────────────────────────────
  // One query, joined in memory. Invoice rows already carry the invoice's own
  // internal note as a fallback, but a note written HERE wins — they're
  // different things and the chase note is the one this report is about.
  {
    const sb = commercialDb();
    const { data } = await sb
      .from("commercial_receivable_notes")
      .select("row_key, note")
      .in("row_key", rows.map((r) => r.key));
    const byKey = new Map(
      ((data ?? []) as { row_key: string; note: string }[]).map((n) => [n.row_key, n.note])
    );
    for (const r of rows) {
      const written = byKey.get(r.key)?.trim();
      if (written) r.note = written;
    }
  }

  // Biggest first — the way you actually work a chase list.
  rows.sort((a, b) => b.openCents - a.openCents);

  const retainageCents = rows
    .filter((r) => r.kind === "retainage")
    .reduce((n, r) => n + r.openCents, 0);
  const totalOpenCents = rows.reduce((n, r) => n + r.openCents, 0);
  const overdueCents = rows
    .filter((r) => (r.daysOut ?? 0) > 0)
    .reduce((n, r) => n + r.openCents, 0);

  return {
    rows,
    totalOpenCents,
    retainageCents,
    dueNowCents: totalOpenCents - retainageCents,
    overdueCents,
    generatedAt: new Date(nowMs).toISOString(),
  };
}


/** Write (or clear) the chase note on one receivable row. */
export async function setReceivableNote(
  rowKey: string,
  note: string,
  userId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmed = note.trim().slice(0, 500);
  const sb = commercialDb();
  if (!trimmed) {
    const { error } = await sb.from("commercial_receivable_notes").delete().eq("row_key", rowKey);
    return error ? { ok: false, error: "Couldn't clear that note. Please try again." } : { ok: true };
  }
  const { error } = await sb
    .from("commercial_receivable_notes")
    .upsert(
      { row_key: rowKey, note: trimmed, updated_by_user_id: userId, updated_at: new Date().toISOString() },
      { onConflict: "row_key" }
    );
  return error ? { ok: false, error: "Couldn't save that note. Please try again." } : { ok: true };
}
