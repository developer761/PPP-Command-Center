import "server-only";
import {
  costToolHref as costToolHrefFor,
  moneyInHref,
} from "@/lib/commercial/reports/tomco/accounting-links";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { derivedOppName } from "@/lib/commercial/opportunities/db";
import { purchaseCategoryLabel } from "@/lib/commercial/purchases/constants";
import type { ReportSpec } from "@/lib/commercial/reports/grouped/spec";

/**
 * Mary's money-out and money-in reports, off one read each.
 *
 *   Purchases by Vendor        — every purchase, grouped by who we bought from
 *   Labor Payments Out         — crew payouts, grouped by who was paid
 *   Reimbursements             — what was paid back, and to whom
 *   Partner Deposit History    — money in, grouped by the day it was deposited
 *
 * She runs the first three filtered to a week or a vendor, so the date window
 * and the vendor filter are part of the report rather than something she has to
 * re-derive. "Aboffs Transactions Report" is Purchases by Vendor with Aboffs
 * picked — the same report, which is why it is not a separate one.
 */

export type SpendRow = {
  id: string;
  oppId: string | null;
  /** The GC's account id — the cost tool lives under it. */
  accountId: string | null;
  jobName: string;
  vendor: string;
  category: string;
  categoryLabel: string;
  ymd: string | null;
  amountCents: number;
  reference: string | null;
  hasReceipt: boolean;
  reimburseTo: string | null;
  reimbursedYmd: string | null;
};

export type MoneyInRow = {
  id: string;
  oppId: string | null;
  jobName: string;
  accountName: string;
  ymd: string | null;
  depositedYmd: string | null;
  amountCents: number;
  method: string | null;
  reference: string | null;
};

const ymdOf = (v: string | null | undefined): string | null =>
  v ? String(v).slice(0, 10) : null;

/** Every purchase, with the job and vendor named. */
export async function getSpendRows(): Promise<SpendRow[]> {
  const sb = commercialDb();
  const purchases = await paginateAll<{
    id: string;
    opportunity_id: string | null;
    account_id: string | null;
    category: string | null;
    vendor: string | null;
    amount_cents: number;
    purchased_at: string | null;
    description: string | null;
    receipt_document_id: string | null;
    reimburse_to: string | null;
    reimbursed_at: string | null;
  }>(() =>
    sb
      .from("commercial_project_purchases")
      .select(
        "id, opportunity_id, account_id, category, vendor, amount_cents, purchased_at, description, receipt_document_id, reimburse_to, reimbursed_at",
      )
      .is("deleted_at", null)
      .order("id", { ascending: true }),
  );
  const names = await jobNames(purchases.map((p) => p.opportunity_id));

  return purchases.map((p) => ({
    id: p.id,
    oppId: p.opportunity_id,
    accountId: p.account_id,
    jobName: (p.opportunity_id && names.get(p.opportunity_id)) || "—",
    vendor: (p.vendor ?? "").trim() || "—",
    category: p.category ?? "other",
    categoryLabel: purchaseCategoryLabel(p.category ?? "other"),
    ymd: ymdOf(p.purchased_at),
    amountCents: Number(p.amount_cents),
    // Salesforce calls this "Reference Id" and Tomco puts the receipt number,
    // the dimensions, or the hours worked in it. It is the column Mary matches
    // against the paperwork, so it is not dropped as "just a description".
    reference: (p.description ?? "").trim() || null,
    hasReceipt: !!p.receipt_document_id,
    reimburseTo: (p.reimburse_to ?? "").trim() || null,
    reimbursedYmd: ymdOf(p.reimbursed_at),
  }));
}

/** Every payment in, with the job and GC named. */
export async function getMoneyInRows(): Promise<MoneyInRow[]> {
  const sb = commercialDb();
  const payments = await paginateAll<{
    id: string;
    invoice_id: string;
    amount_cents: number;
    paid_at: string | null;
    deposited_at: string | null;
    method: string | null;
    reference: string | null;
  }>(() =>
    sb
      .from("commercial_invoice_payments")
      .select(
        "id, invoice_id, amount_cents, paid_at, deposited_at, method, reference",
      )
      .order("id", { ascending: true }),
  );
  /**
   * AIA certificate payments belong on this tab too.
   *
   * This is the screen you open with a bank statement and tick cash off. It
   * read commercial_invoice_payments only, so from 2026-09-24 — when a G702
   * certificate could be paid directly — that cash could never be reconciled.
   * `deposited_at` existed on the table and nothing could write it.
   *
   * Tolerates the table being absent (migration not applied), in which case
   * this reads exactly as it did before.
   */
  const aiaPayments = await paginateAll<{
    id: string;
    application_id: string;
    amount_cents: number;
    paid_at: string | null;
    deposited_at: string | null;
    method: string | null;
    reference: string | null;
  }>(() =>
    sb
      .from("commercial_aia_payments")
      .select("id, application_id, amount_cents, paid_at, deposited_at, method, reference")
      .is("deleted_at", null)
      .order("id", { ascending: true }),
  ).catch(() => []);

  if (payments.length === 0 && aiaPayments.length === 0) return [];

  const invoices = await paginateAll<{
    id: string;
    opportunity_id: string | null;
    account_id: string;
  }>(() =>
    sb
      .from("commercial_invoices")
      .select("id, opportunity_id, account_id")
      .in("id", [...new Set(payments.map((p) => p.invoice_id))])
      .order("id", { ascending: true }),
  );
  const invById = new Map(invoices.map((i) => [i.id, i]));
  const names = await jobNames(invoices.map((i) => i.opportunity_id));
  const { data: accounts } = await sb
    .from("commercial_accounts")
    .select("id, company_name")
    .in("id", [...new Set(invoices.map((i) => i.account_id))]);
  const acct = new Map(
    ((accounts ?? []) as { id: string; company_name: string | null }[]).map(
      (a) => [a.id, a.company_name],
    ),
  );

  const invoiceRows: MoneyInRow[] = payments.map((p) => {
    const inv = invById.get(p.invoice_id);
    return {
      id: p.id,
      oppId: inv?.opportunity_id ?? null,
      jobName: (inv?.opportunity_id && names.get(inv.opportunity_id)) || "—",
      accountName: (inv && acct.get(inv.account_id)) || "—",
      ymd: ymdOf(p.paid_at),
      depositedYmd: ymdOf(p.deposited_at),
      amountCents: Number(p.amount_cents),
      method: p.method,
      reference: (p.reference ?? "").trim() || null,
    };
  });

  if (aiaPayments.length === 0) return invoiceRows;

  const apps = await paginateAll<{
    id: string;
    opportunity_id: string | null;
    account_id: string;
    application_number: number;
  }>(() =>
    sb
      .from("commercial_aia_applications")
      .select("id, opportunity_id, account_id, application_number")
      .in("id", [...new Set(aiaPayments.map((p) => p.application_id))])
      .is("deleted_at", null)
      .order("id", { ascending: true }),
  );
  const appById = new Map(apps.map((a) => [a.id, a] as const));
  const aiaNames = await jobNames(apps.map((a) => a.opportunity_id));
  const { data: aiaAccounts } = await sb
    .from("commercial_accounts")
    .select("id, company_name")
    .in("id", [...new Set(apps.map((a) => a.account_id))]);
  const aiaAcct = new Map(
    ((aiaAccounts ?? []) as { id: string; company_name: string | null }[]).map(
      (a) => [a.id, a.company_name],
    ),
  );

  const aiaRows: MoneyInRow[] = [];
  for (const p of aiaPayments) {
    const app = appById.get(p.application_id);
    // A payment on a deleted certificate is gone from the app; it must be gone
    // from here too, or the tab never ties out against the bank statement.
    if (!app) continue;
    aiaRows.push({
      id: p.id,
      oppId: app.opportunity_id ?? null,
      jobName: (app.opportunity_id && aiaNames.get(app.opportunity_id)) || "—",
      accountName: aiaAcct.get(app.account_id) || "—",
      ymd: ymdOf(p.paid_at),
      depositedYmd: ymdOf(p.deposited_at),
      amountCents: Number(p.amount_cents),
      method: p.method,
      reference: (p.reference ?? "").trim() || `AIA No. ${app.application_number}`,
    });
  }

  return [...invoiceRows, ...aiaRows].sort((a, b) => (a.ymd ?? "").localeCompare(b.ymd ?? ""));
}

/** Job names for a set of opportunity ids, resolved once. */
async function jobNames(ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map();
  const sb = commercialDb();
  const opps = await paginateAll<{
    id: string;
    account_id: string;
    title: string | null;
    client_name: string | null;
    title_override: string | null;
    title_override_mode: string | null;
    property_street: string | null;
  }>(() =>
    sb
      .from("commercial_opportunities")
      .select(
        "id, account_id, title, client_name, title_override, title_override_mode, property_street",
      )
      .in("id", unique)
      .order("id", { ascending: true }),
  );
  const { data: accounts } = await sb
    .from("commercial_accounts")
    .select("id, company_name")
    .in("id", [...new Set(opps.map((o) => o.account_id))]);
  const acct = new Map(
    ((accounts ?? []) as { id: string; company_name: string | null }[]).map(
      (a) => [a.id, a.company_name],
    ),
  );
  return new Map(
    opps.map((o) => [
      o.id,
      derivedOppName(
        { ...o, title: o.title ?? "" },
        acct.get(o.account_id) ?? null,
      ),
    ]),
  );
}

// ─── Specs ──────────────────────────────────────────────────────────────────

/**
 * The job link opens the COST TOOL, not the deal page.
 *
 * Karan 2026-09-16: "if I go onto purchases and then click a job it brings me
 * to [the deal page] — I want it to bring me to the place where I can put
 * purchases, and then a back button so I can cleanly go back."
 *
 * It carries the tab it came from as `?back=`, which the tool's header turns
 * into "← Purchases". Falls back to the deal page for a row with no account on
 * it, because a link that goes somewhere useful beats one that does nothing.
 */
const costToolHref = (r: SpendRow, backView: string): string | null =>
  costToolHrefFor(r.oppId, backView);

const jobColumn = {
  key: "job",
  label: "Name",
  text: (r: SpendRow) => r.jobName,
  href: (r: SpendRow) => costToolHref(r, "purchases"),
};

export const PURCHASES_BY_VENDOR_SPEC: ReportSpec<SpendRow> = {
  title: "Purchases by Vendor",
  sourceLabel: "Work Orders with Transactions",
  blurb:
    "Every purchase, grouped by who we bought it from. Pick a vendor to get that vendor's own statement.",
  totals: [
    {
      label: "Total amount",
      value: (rows) => rows.reduce((n, r) => n + r.amountCents, 0),
    },
  ],
  groupings: [
    [{ key: "vendor", label: "Vendor", of: (r) => r.vendor }],
    [{ key: "job", label: "Job", of: (r) => r.jobName }],
    /**
     * JOB → VENDOR. Stephanie via Katie, 2026-09-18:
     *
     *   "Can we add a job cost by vendor report? Where we can see how much
     *   total we spent at each vendor for a specific job? Ex: for Home Goods,
     *   Shirley we spent $4k at Sherwin, $5k at Aboffs, $3k at Sunbelt. There
     *   are times when we have to complete reporting and waivers for GC showing
     *   total material costs by vendor."
     *
     * Nothing new was needed to answer it. `groupings` is an array of arrays
     * because a grouping can be SEVERAL LEVELS DEEP — `buildGroups` recurses —
     * and the report already had Vendor and Job as separate one-level cuts.
     * Nesting them gives a subtotal per vendor inside a subtotal per job, which
     * is the shape of a waiver.
     *
     * It inherits the CSV export for free, which is the half that matters: a
     * GC waiver is a document she has to hand over, not a screen to read.
     */
    [
      { key: "job", label: "Job", of: (r) => r.jobName },
      { key: "vendor", label: "Vendor", of: (r) => r.vendor },
    ],
    [
      {
        key: "month",
        label: "Month",
        of: (r) => (r.ymd ? r.ymd.slice(0, 7) : "—"),
      },
    ],
  ],
  columns: [
    jobColumn,
    { key: "date", label: "Date", text: (r) => r.ymd },
    {
      key: "type",
      label: "Record type",
      text: (r) => r.categoryLabel,
      secondary: true,
    },
    {
      key: "amount",
      label: "Amount",
      kind: "money",
      amount: (r) => r.amountCents,
    },
    {
      key: "reference",
      label: "Reference",
      text: (r) => r.reference,
      secondary: true,
    },
    {
      key: "receipt",
      label: "Receipt",
      text: (r) => (r.hasReceipt ? "Yes" : null),
      secondary: true,
    },
  ],
};

const laborJobColumn = {
  ...jobColumn,
  href: (r: SpendRow) => costToolHref(r, "labor-out"),
};

export const LABOR_PAYMENTS_SPEC: ReportSpec<SpendRow> = {
  title: "Labor Payments Out",
  sourceLabel: "Work Orders with Transactions",
  blurb: "What went out to the crews, grouped by who was paid.",
  totals: [
    {
      label: "Total amount",
      value: (rows) => rows.reduce((n, r) => n + r.amountCents, 0),
    },
  ],
  groupings: [
    [{ key: "payee", label: "Payee", of: (r) => r.vendor }],
    [{ key: "job", label: "Job", of: (r) => r.jobName }],
  ],
  columns: [
    laborJobColumn,
    { key: "date", label: "Date", text: (r) => r.ymd },
    {
      key: "amount",
      label: "Amount",
      kind: "money",
      amount: (r) => r.amountCents,
    },
    { key: "reference", label: "Reference", text: (r) => r.reference },
  ],
};

export const REIMBURSEMENTS_SPEC: ReportSpec<SpendRow> = {
  title: "Reimbursements",
  sourceLabel: "Work Orders with Transactions",
  blurb: "Money paid back out of pocket, grouped by who it went to.",
  totals: [
    {
      label: "Total amount",
      value: (rows) => rows.reduce((n, r) => n + r.amountCents, 0),
    },
  ],
  groupings: [
    [
      {
        key: "to",
        label: "Reimbursed to",
        of: (r) => r.reimburseTo ?? r.vendor,
      },
    ],
    [{ key: "job", label: "Job", of: (r) => r.jobName }],
  ],
  columns: [
    jobColumn,
    { key: "date", label: "Date", text: (r) => r.ymd },
    {
      key: "amount",
      label: "Amount",
      kind: "money",
      amount: (r) => r.amountCents,
    },
    {
      key: "settled",
      label: "Reimbursed",
      text: (r) => r.reimbursedYmd ?? "Not yet",
      secondary: true,
    },
    {
      key: "reference",
      label: "Reference",
      text: (r) => r.reference,
      secondary: true,
    },
  ],
};

export const DEPOSIT_HISTORY_SPEC: ReportSpec<MoneyInRow> = {
  title: "Partner Deposit History",
  sourceLabel: "Work Orders with Transactions",
  // Says what this tab IS, next to what Receivables is, because the two are
  // easy to mix up and nothing on either page said so. Karan 2026-09-17:
  // "write it here so we know."
  blurb:
    "Money that has ARRIVED, by the day it landed — the history you read against the bank statement. Receivables is the other half: money that has not arrived yet. Tick each one off here as it clears.",
  totals: [
    {
      label: "Total amount",
      value: (rows) => rows.reduce((n, r) => n + r.amountCents, 0),
    },
  ],
  groupings: [
    [{ key: "date", label: "Date", of: (r) => r.ymd ?? "—" }],
    [{ key: "gc", label: "GC", of: (r) => r.accountName }],
    [{ key: "method", label: "Method", of: (r) => r.method ?? "—" }],
  ],
  columns: [
    // Money IN, so the job opens its invoices — where the next payment gets
    // recorded — rather than the costs tool.
    {
      key: "job",
      label: "Name",
      text: (r) => r.jobName,
      href: (r) => moneyInHref(r.oppId, "deposits"),
    },
    { key: "gc", label: "GC", text: (r) => r.accountName, secondary: true },
    {
      key: "amount",
      label: "Amount",
      kind: "money",
      amount: (r) => r.amountCents,
    },
    { key: "method", label: "Method", text: (r) => r.method },
    {
      key: "deposited",
      label: "Deposited",
      text: (r) => r.depositedYmd,
      secondary: true,
    },
  ],
};

// ─── Row filters ────────────────────────────────────────────────────────────

/** Materials and everything that is not crew labor or a reimbursement. */
export const purchaseRows = (rows: SpendRow[], vendor?: string) =>
  rows
    .filter((r) => r.category !== "labor" && !r.reimburseTo)
    .filter((r) => !vendor || r.vendor === vendor)
    .sort((a, b) => (b.ymd ?? "").localeCompare(a.ymd ?? ""));

export const laborPaymentRows = (rows: SpendRow[]) =>
  rows
    .filter((r) => r.category === "labor")
    .sort((a, b) => (b.ymd ?? "").localeCompare(a.ymd ?? ""));

export const reimbursementRows = (rows: SpendRow[]) =>
  rows
    .filter((r) => !!r.reimburseTo)
    .sort((a, b) => (b.ymd ?? "").localeCompare(a.ymd ?? ""));

/** Every distinct vendor, biggest spend first — the picker's options. */
export function vendorOptions(
  rows: SpendRow[],
): { name: string; cents: number }[] {
  const by = new Map<string, number>();
  for (const r of rows)
    by.set(r.vendor, (by.get(r.vendor) ?? 0) + r.amountCents);
  return [...by.entries()]
    .map(([name, cents]) => ({ name, cents }))
    .sort((a, b) => b.cents - a.cents);
}
