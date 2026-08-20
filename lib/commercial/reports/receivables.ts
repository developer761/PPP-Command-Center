import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { listCommercialInvoices } from "@/lib/commercial/invoices/db";
import { deriveInvoiceStatus, DEFAULT_DUE_DAYS } from "@/lib/commercial/invoices/constants";
import { listCommercialOpportunities, derivedOppName } from "@/lib/commercial/opportunities/db";
import { aiaBillingRollupBulk } from "@/lib/commercial/aia/db";
import { daysPastDue } from "./ar-aging";
import { etDateOf } from "@/lib/date-et";

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
  /** The deal this money sits on. Null only for an account-level invoice. */
  opportunityId: string | null;
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
  /** The specific document — this invoice, this AIA application. */
  href: string;
  /** The JOB's billing, not the document. Mary's actual question on a chase
   *  call is "what has this job been billed and what's been paid", which the
   *  single document can't answer — so the job name and the reference go to
   *  two different places on purpose. Null when there's no deal to open. */
  billingHref: string | null;
};

export type ReceivableFilters = {
  /** Billed/issued on or after this ET date. */
  fromYmd?: string;
  /** Billed/issued on or before this ET date. */
  toYmd?: string;
  /** Only invoices, only AIA, only retention. */
  kind?: ReceivableKind;
  /** Only what is actually late. Retention is never late, so it drops out. */
  overdueOnly?: boolean;
  /** One GC. */
  accountId?: string;
  /** `amount` (default) works the book biggest-first; `oldest` works it in
   *  chase order, which is how you actually clear the tail. */
  sort?: "amount" | "oldest";
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
  /** Rows before filtering — so the page can say "12 of 48" rather than
   *  looking empty for reasons the reader can't see. */
  unfilteredCount: number;
  /** Open items the period filter could not place, because nothing recorded
   *  when they were billed. Surfaced, never silently dropped: a receivable
   *  that vanishes when you pick a date range is the worst kind of bug on a
   *  chase list — you stop chasing money you no longer know exists. */
  undatedExcluded: number;
  /** Whether any filter is actually narrowing the list. */
  filtered: boolean;
  /** Every GC in the UNFILTERED book, for the picker — so it never offers a
   *  name that yields nothing, and never hides one because it's filtered out. */
  gcOptions: { id: string; name: string }[];
  /** The GC holding the largest share of what's outstanding, and that share.
   *  Concentration is the risk a total hides: $500k owed is a different
   *  business depending on whether it's forty GCs or one. */
  topGc: { id: string; name: string; cents: number; sharePct: number } | null;
  /** Fingerprint of the WHOLE book, BEFORE filtering — what the AI brief's
   *  staleness is measured against.
   *
   *  It has to be filter-independent. The brief is always written from the
   *  whole book (one read for Alex, never a slice), so hashing the rows a
   *  particular page happens to be showing made every filtered view declare a
   *  perfectly current brief "stale" — and clicking Rewrite couldn't clear it,
   *  because the rewrite hashed the whole book again while the page compared
   *  against its filtered slice. */
  bookFingerprint: string;
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

export async function getReceivablesReport(
  nowMs = Date.now(),
  filters: ReceivableFilters = {}
): Promise<ReceivablesReport> {
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
      opportunityId: inv.opportunity_id ?? null,
      jobName: job,
      openCents: open,
      reference: [inv.invoice_number, issued ? `sent ${fmtRefDate(issued)}` : null]
        .filter(Boolean)
        .join(" · "),
      note: inv.notes?.trim() || null,
      issuedIso: issued,
      daysOut: inv.due_at ? daysPastDue(inv.due_at, nowMs) : null,
      href: `/commercial/invoices/${inv.id}`,
      billingHref: inv.opportunity_id
        ? `/commercial/opportunities/${inv.opportunity_id}?tab=invoices`
        : null,
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
        opportunityId: oppId,
        jobName: job,
        openCents: roll.dueNowCents,
        // Mary writes this by hand as "AIA#3-7/22/26". Same thing, generated.
        reference: `AIA #${roll.latestIssuedNumber}${issuedIso ? ` · sent ${fmtRefDate(issuedIso)}` : ""}`,
        note: null,
        issuedIso,
        daysOut: dueAt ? daysPastDue(dueAt, nowMs) : null,
        href: `/commercial/opportunities/${oppId}?tab=aia&app=${roll.latestIssuedId}`,
        billingHref: `/commercial/opportunities/${oppId}?tab=aia`,
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
        opportunityId: oppId,
        jobName: job,
        openCents: roll.retainageHeldCents,
        reference: `Retention · AIA #${roll.latestIssuedNumber}`,
        note: null,
        issuedIso,
        daysOut: null,
        href: `/commercial/opportunities/${oppId}?tab=aia`,
        billingHref: `/commercial/opportunities/${oppId}?tab=aia`,
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

  return summarizeReceivables(rows, filters, nowMs);
}

/**
 * Apply the filters and total what survives. Pure, so the filter rules are
 * testable without a database.
 *
 * The totals are computed over the FILTERED rows on purpose: if you narrow to
 * one GC, "total outstanding" must be that GC's total, or the tiles contradict
 * the list directly beneath them.
 */
export function summarizeReceivables(
  allRows: ReceivableRow[],
  filters: ReceivableFilters = {},
  nowMs = Date.now()
): ReceivablesReport {
  const { fromYmd, toYmd, kind, overdueOnly, accountId, sort = "amount" } = filters;
  const hasPeriod = !!(fromYmd || toYmd);
  const filtered = hasPeriod || !!kind || !!overdueOnly || !!accountId;

  let undatedExcluded = 0;
  const rows = allRows.filter((r) => {
    if (kind && r.kind !== kind) return false;
    if (accountId && r.accountId !== accountId) return false;
    // Retention has no due date and is never late, so it correctly drops out
    // of an overdue-only view rather than being counted as current.
    if (overdueOnly && (r.daysOut ?? 0) <= 0) return false;
    if (hasPeriod) {
      // The ET calendar date it was billed. Compared as YYYY-MM-DD strings,
      // which sorts correctly and can't be shifted by a timezone.
      const ymd = r.issuedIso ? etDateOf(r.issuedIso) : null;
      if (!ymd) {
        // Counted and reported, never silently dropped.
        undatedExcluded += 1;
        return false;
      }
      if (fromYmd && ymd < fromYmd) return false;
      if (toYmd && ymd > toYmd) return false;
    }
    return true;
  });

  // Sorted here rather than at the caller, so the page, the export and the
  // email can never present the same filtered book in a different order.
  rows.sort((a, b) =>
    sort === "oldest"
      // Most overdue first. Retention and undated rows have no age, so they
      // sink to the bottom instead of pretending to be the oldest debt.
      ? (b.daysOut ?? -Infinity) - (a.daysOut ?? -Infinity) || b.openCents - a.openCents
      : b.openCents - a.openCents || a.jobName.localeCompare(b.jobName)
  );

  const retainageCents = rows
    .filter((r) => r.kind === "retainage")
    .reduce((n, r) => n + r.openCents, 0);
  const totalOpenCents = rows.reduce((n, r) => n + r.openCents, 0);
  const overdueCents = rows
    .filter((r) => (r.daysOut ?? 0) > 0)
    .reduce((n, r) => n + r.openCents, 0);

  const gcOptions = [...new Map(allRows.map((r) => [r.accountId, r.accountName])).entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Concentration, over the rows actually shown.
  const byGc = new Map<string, { name: string; cents: number }>();
  for (const r of rows) {
    const cur = byGc.get(r.accountId) ?? { name: r.accountName, cents: 0 };
    cur.cents += r.openCents;
    byGc.set(r.accountId, cur);
  }
  let topGc: ReceivablesReport["topGc"] = null;
  for (const [id, v] of byGc) {
    if (!topGc || v.cents > topGc.cents) {
      topGc = {
        id,
        name: v.name,
        cents: v.cents,
        sharePct: totalOpenCents > 0 ? Math.round((v.cents / totalOpenCents) * 100) : 0,
      };
    }
  }

  // Over allRows, and order-independent (the map is sorted), so the same book
  // fingerprints identically no matter which slice is on screen.
  const bookFingerprint = allRows
    .map((r) => `${r.key}:${r.openCents}:${r.daysOut ?? ""}:${(r.note ?? "").slice(0, 80)}`)
    .sort()
    .join("|");

  return {
    rows,
    gcOptions,
    topGc,
    bookFingerprint,
    unfilteredCount: allRows.length,
    undatedExcluded,
    filtered,
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
