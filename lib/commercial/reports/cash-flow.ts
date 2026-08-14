import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { etDateOf } from "@/lib/date-et";

/**
 * Cash flow & collections — money actually RECEIVED, and how long it took.
 *
 * The gap this fills: the dashboard trends what is BILLED and AR aging is a
 * snapshot of what is OWED. Nothing showed what arrived, or how slowly. Billed
 * is not collected, and a contractor's problem is almost never the first.
 *
 * Decisions that make the numbers mean something:
 *
 * - **Keyed on `paid_at`, not the invoice date.** A March invoice paid in July
 *   is July's cash. That is the whole point of a cash-flow view, and it is why
 *   this can't just be AR aging with a date filter.
 *
 * - **Days-to-pay is weighted by AMOUNT, per payment.** A $200k wire that took
 *   20 days and a $500 cheque that took 90 tell you very different things about
 *   your cash, and a plain average lets the cheque shout as loudly. Each
 *   payment carries its own lag from the invoice's issue date.
 *
 * - **Payments before the invoice issued are clamped to 0, not dropped.** A
 *   deposit taken on a handshake is real money in, and it genuinely arrived in
 *   zero days. Dropping it would understate collections; letting it go negative
 *   would flatter the average.
 *
 * - **Voided invoices are excluded**, along with their payments. A payment
 *   against a void invoice is a data-entry artefact, not cash.
 */

export type CashMonth = {
  /** YYYY-MM. */
  key: string;
  label: string;
  collectedCents: number;
  billedCents: number;
  paymentCount: number;
};

export type CashByMethod = {
  method: string;
  label: string;
  collectedCents: number;
  count: number;
};

export type SlowPayer = {
  accountId: string;
  accountName: string;
  collectedCents: number;
  /** Amount-weighted days to pay, this customer only. */
  avgDaysToPay: number | null;
  openCents: number;
};

export type CashFlowReport = {
  months: CashMonth[];
  byMethod: CashByMethod[];
  slowest: SlowPayer[];
  totals: {
    collectedCents: number;
    billedCents: number;
    paymentCount: number;
    /** Amount-weighted mean days from invoice issued to payment received. */
    avgDaysToPay: number | null;
    /** Collected ÷ billed over the same window, as a percent. Above 100 just
     *  means older invoices landed in this window — it is not an error. */
    collectionRatePct: number | null;
    openCents: number;
  };
  /** Payments we couldn't time because their invoice has no issue date. */
  untimedPayments: number;
  /** Payments that landed before their invoice was issued — deposits. Counted
   *  as same-day rather than negative. */
  paidBeforeIssued: number;
};

const EMPTY: CashFlowReport = {
  months: [],
  byMethod: [],
  slowest: [],
  totals: { collectedCents: 0, billedCents: 0, paymentCount: 0, avgDaysToPay: null, collectionRatePct: null, openCents: 0 },
  untimedPayments: 0,
  paidBeforeIssued: 0,
};

const METHOD_LABEL: Record<string, string> = {
  check: "Cheque",
  ach: "ACH",
  wire: "Wire",
  credit_card: "Card",
  other: "Other",
};

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.UTC(+fromYmd.slice(0, 4), +fromYmd.slice(5, 7) - 1, +fromYmd.slice(8, 10));
  const b = Date.UTC(+toYmd.slice(0, 4), +toYmd.slice(5, 7) - 1, +toYmd.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    year: "2-digit",
  });
}

export async function getCashFlowReport(range: {
  fromYmd: string;
  toYmd: string;
}): Promise<CashFlowReport> {
  const sb = commercialDb();

  const invoices = await paginateAll<{
    id: string;
    account_id: string | null;
    status: string;
    issued_at: string | null;
    subtotal_cents: number;
    total_cents: number;
    paid_cents: number;
    balance_cents: number;
  }>(() =>
    sb
      .from("commercial_invoices")
      .select("id, account_id, status, issued_at, subtotal_cents, total_cents, paid_cents, balance_cents")
      .neq("status", "void")
      .is("deleted_at", null)
      .order("id")
  );
  if (invoices.length === 0) return EMPTY;
  const invById = new Map(invoices.map((i) => [i.id, i]));

  const payments = await paginateAll<{
    invoice_id: string;
    amount_cents: number;
    paid_at: string;
    method: string | null;
  }>(() =>
    sb
      .from("commercial_invoice_payments")
      .select("invoice_id, amount_cents, paid_at, method")
      .order("paid_at")
      .order("id")
  );

  const accountIds = [...new Set(invoices.map((i) => i.account_id).filter(Boolean))] as string[];
  const accountName = new Map<string, string>();
  if (accountIds.length > 0) {
    const { data } = await sb.from("commercial_accounts").select("id, company_name").in("id", accountIds);
    for (const a of (data ?? []) as { id: string; company_name: string | null }[]) {
      accountName.set(a.id, a.company_name?.trim() || "Unnamed account");
    }
  }

  const months = new Map<string, CashMonth>();
  const methods = new Map<string, CashByMethod>();
  const byAccount = new Map<string, { collected: number; lagWeighted: number; lagAmount: number }>();
  let collected = 0;
  let paymentCount = 0;
  let lagWeighted = 0; // Σ (days × amount)
  let lagAmount = 0; // Σ amount that could be timed
  let untimedPayments = 0;
  let paidBeforeIssued = 0;

  for (const p of payments) {
    const inv = invById.get(p.invoice_id);
    if (!inv) continue; // voided or deleted invoice — not cash
    const ymd = etDateOf(p.paid_at);
    if (!ymd || ymd < range.fromYmd || ymd > range.toYmd) continue;

    const amount = Number(p.amount_cents) || 0;
    if (amount <= 0) continue;
    collected += amount;
    paymentCount += 1;

    const mKey = ymd.slice(0, 7);
    const m = months.get(mKey) ?? { key: mKey, label: monthLabel(mKey), collectedCents: 0, billedCents: 0, paymentCount: 0 };
    m.collectedCents += amount;
    m.paymentCount += 1;
    months.set(mKey, m);

    const methodKey = (p.method ?? "other").toLowerCase();
    const mm = methods.get(methodKey) ?? { method: methodKey, label: METHOD_LABEL[methodKey] ?? "Other", collectedCents: 0, count: 0 };
    mm.collectedCents += amount;
    mm.count += 1;
    methods.set(methodKey, mm);

    const issued = etDateOf(inv.issued_at);
    if (!issued) {
      untimedPayments += 1;
    } else {
      const raw = daysBetween(issued, ymd);
      // A deposit taken before the invoice went out really did arrive in zero
      // days. Clamping keeps it in the average instead of flattering it.
      if (raw < 0) paidBeforeIssued += 1;
      const days = Math.max(0, raw);
      lagWeighted += days * amount;
      lagAmount += amount;
    }

    if (inv.account_id) {
      const a = byAccount.get(inv.account_id) ?? { collected: 0, lagWeighted: 0, lagAmount: 0 };
      a.collected += amount;
      if (issued) {
        a.lagWeighted += Math.max(0, daysBetween(issued, ymd)) * amount;
        a.lagAmount += amount;
      }
      byAccount.set(inv.account_id, a);
    }
  }

  // Billed in the same window, so the two lines on the chart answer the same
  // question: what went out vs what came in.
  //
  // TAX BASIS (review session 2026-08-13): this is a COLLECTIONS report, so
  // both sides are with-tax. `collected` sums payments, which cover the invoice
  // TOTAL (tax included — the customer owes the tax and pays it to us to remit).
  // Billing it against pre-tax `subtotal_cents` reported ~108% collection on a
  // fully-paid taxable job and put the collected bar above billed for the same
  // money. Billed is the with-tax `total_cents` — the amount actually invoiced
  // to the customer — so the rate is cash-in ÷ invoiced-to-customer and the two
  // chart lines share a basis. (Same principle the deal analytics settled in
  // 6d972cf: a with-tax figure is measured against the with-tax total.)
  let billed = 0;
  for (const inv of invoices) {
    const issued = etDateOf(inv.issued_at);
    if (!issued || issued < range.fromYmd || issued > range.toYmd) continue;
    const amt = Number(inv.total_cents) || 0;
    billed += amt;
    const mKey = issued.slice(0, 7);
    const m = months.get(mKey) ?? { key: mKey, label: monthLabel(mKey), collectedCents: 0, billedCents: 0, paymentCount: 0 };
    m.billedCents += amt;
    months.set(mKey, m);
  }

  // What is still out, right now — the bridge to AR aging. Per-invoice clamp so
  // one overpayment can't mask another invoice's debt.
  // A DRAFT has a generated balance but has never been sent, so counting it as
  // owed overstated the receivable and made this figure impossible to
  // reconcile against AR Aging — which is issued-only. Nobody owes you money
  // you have not billed them for.
  const isReceivable = (i: { status: string }) => i.status !== "draft";
  const openCents = invoices
    .filter(isReceivable)
    .reduce((n, i) => n + Math.max(0, Number(i.balance_cents) || 0), 0);
  const openByAccount = new Map<string, number>();
  for (const i of invoices) {
    if (!i.account_id || !isReceivable(i)) continue;
    openByAccount.set(i.account_id, (openByAccount.get(i.account_id) ?? 0) + Math.max(0, Number(i.balance_cents) || 0));
  }

  const slowest: SlowPayer[] = [...byAccount.entries()]
    .map(([id, a]) => ({
      accountId: id,
      accountName: accountName.get(id) ?? "Unnamed account",
      collectedCents: a.collected,
      avgDaysToPay: a.lagAmount > 0 ? Math.round(a.lagWeighted / a.lagAmount) : null,
      openCents: openByAccount.get(id) ?? 0,
    }))
    // Slowest first — the question is who to chase. Customers we can't time
    // sink to the bottom rather than sorting as if they were instant.
    .sort((a, b) => (b.avgDaysToPay ?? -1) - (a.avgDaysToPay ?? -1) || b.collectedCents - a.collectedCents);

  return {
    months: [...months.values()].sort((a, b) => a.key.localeCompare(b.key)),
    byMethod: [...methods.values()].sort((a, b) => b.collectedCents - a.collectedCents),
    slowest,
    totals: {
      collectedCents: collected,
      billedCents: billed,
      paymentCount,
      avgDaysToPay: lagAmount > 0 ? Math.round(lagWeighted / lagAmount) : null,
      collectionRatePct: billed > 0 ? Math.round((collected / billed) * 100) : null,
      openCents,
    },
    untimedPayments,
    paidBeforeIssued,
  };
}
