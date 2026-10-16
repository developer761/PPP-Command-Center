import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { aiaIssuedAtFrom } from "@/lib/commercial/aia/constants";
import { loadPeriodBilling, type PeriodInvoice } from "./period-billing";
import { dealsBilledViaAia, isSupersededByAia } from "@/lib/commercial/invoices/carryover";
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
    /** Collected ÷ billed over the same window, as a percent. BOTH ledgers on
     *  both sides — see the denominator note in getCashFlowReport. Modestly
     *  above 100 means older bills landed in this window; a multiple of 100
     *  means the two sides are not measuring the same book, which is the bug
     *  this used to have. */
    collectionRatePct: number | null;
    openCents: number;
  };
  /** Payments we couldn't time because their invoice has no issue date. */
  untimedPayments: number;
  /** Payments that landed before their invoice was issued — deposits. Counted
   *  as same-day rather than negative. */
  paidBeforeIssued: number;
};

/** The shape this report returns when there is nothing to report. Exported
 *  so a page can degrade one card instead of failing whole. */
export const EMPTY: CashFlowReport = {
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

/** Last calendar day of a "YYYY-MM" key, as YYYY-MM-DD. */
export function monthEnd(key: string): string {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${key}-${String(d).padStart(2, "0")}`;
}

/** Every "YYYY-MM" from `from` to `to`, inclusive. */
function monthKeysBetween(from: string, to: string): string[] {
  const idx = (k: string) => Number(k.slice(0, 4)) * 12 + Number(k.slice(5, 7)) - 1;
  const out: string[] = [];
  for (let i = idx(from); i <= idx(to); i++) {
    out.push(`${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`);
  }
  return out;
}

/** Which months the range only partly covers. At most two, and with every
 *  cash-flow preset (all of which start on the 1st) at most one. */
function partialMonthsOf(range: { fromYmd: string; toYmd: string }): Set<string> {
  const keys = new Set<string>();
  const firstKey = range.fromYmd.slice(0, 7);
  const lastKey = range.toYmd.slice(0, 7);
  if (range.fromYmd.slice(8, 10) !== "01") keys.add(firstKey);
  if (range.toYmd !== monthEnd(lastKey)) keys.add(lastKey);
  return keys;
}

/**
 * A range needs a SECOND fold only when both of its edge months are partial —
 * then one residual has to be split between two unknowns. No cash-flow preset
 * does this (they all start on the 1st); a hand-typed window can.
 */
export function needsHeadFold(range: { fromYmd: string; toYmd: string }): boolean {
  return partialMonthsOf(range).size === 2;
}

/**
 * The chart's billed line, month by month, clipped to the range.
 *
 * `monthly` from `period-billing` is deliberately NOT range-limited — the
 * dashboard trend draws context around a short window — so a month the range
 * only partly covers would contribute a WHOLE month of billing against a
 * part-month of cash, and the two lines on this chart would stop answering the
 * same question.
 *
 * Whole months inside the range are exact as they stand. The ≤2 edge months
 * take the residual against `rangeTotalCents`, which IS range-exact, so the
 * returned map always sums to it. `headTotalCents` — billing from
 * `range.fromYmd` to the end of that first month — is required only when
 * `needsHeadFold` says both edges are partial.
 */
export function billedMonthsInRange(
  monthly: Map<string, number>,
  rangeTotalCents: number,
  range: { fromYmd: string; toYmd: string },
  headTotalCents?: number
): Map<string, number> {
  const firstKey = range.fromYmd.slice(0, 7);
  const lastKey = range.toYmd.slice(0, 7);
  const partial = partialMonthsOf(range);
  const out = new Map<string, number>();
  let wholeSum = 0;
  for (const key of monthKeysBetween(firstKey, lastKey)) {
    if (partial.has(key)) continue;
    const amt = monthly.get(key) ?? 0;
    out.set(key, amt);
    wholeSum += amt;
  }
  if (partial.size === 1) {
    out.set([...partial][0], rangeTotalCents - wholeSum);
  } else if (partial.size === 2) {
    const head = headTotalCents ?? 0;
    out.set(firstKey, head);
    out.set(lastKey, rangeTotalCents - wholeSum - head);
  }
  return out;
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
    invoice_number: string | null;
    account_id: string | null;
    opportunity_id: string | null;
    status: string;
    issued_at: string | null;
    created_at: string | null;
    subtotal_cents: number;
    total_cents: number;
    paid_cents: number;
    balance_cents: number;
  }>(() =>
    sb
      .from("commercial_invoices")
      .select(
        "id, invoice_number, account_id, opportunity_id, status, issued_at, created_at, subtotal_cents, total_cents, paid_cents, balance_cents"
      )
      .neq("status", "void")
      .is("deleted_at", null)
      .order("id")
  );
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

  /**
   * AIA PAYMENTS ARE CASH TOO.
   *
   * This report reads commercial_invoice_payments and nothing else. From
   * 2026-09-24 a progress certificate can be paid directly, carrying a real
   * date and method — exactly what this chart exists to plot — and none of it
   * landed here. On a contractor who bills most commercial work by G702 that
   * is not an edge case, it is most of the money.
   *
   * They are mapped onto the same shape as an invoice payment so the loop
   * below does not grow a second branch: `issuedAt` comes from the shared
   * `aiaIssuedAtFrom` ladder — the same one AR aging and the chase list use —
   * which is the clock to measure collection lag from.
   */
  const aiaCash = await aiaPaymentsAsCash(range);
  const cashRows: {
    amount_cents: number;
    paid_at: string;
    method: string | null;
    issuedAt: string | null;
    accountId: string | null;
  }[] = [];
  // The `SF-####` carry-over on a job billed by certificate carries the SAME
  // cheques as those certificates' payments (lib/commercial/invoices/
  // carryover.ts), and `aiaCash` below already counts them. The billed side
  // drops the carry-over inside `period-billing`; collected must drop it too,
  // or the rate divides double-counted cash by single-counted billing.
  const billedViaAia = await dealsBilledViaAia(invoices.map((i) => i.opportunity_id ?? ""));
  for (const p of payments) {
    const inv = invById.get(p.invoice_id);
    if (!inv) continue; // voided or deleted invoice — not cash
    if (isSupersededByAia(inv, billedViaAia)) continue;
    cashRows.push({
      amount_cents: Number(p.amount_cents) || 0,
      paid_at: p.paid_at,
      method: p.method,
      issuedAt: inv.issued_at,
      accountId: inv.account_id ?? null,
    });
  }
  cashRows.push(...aiaCash);
  if (aiaCash.length > 0) {
    const missing = [
      ...new Set(
        aiaCash
          .map((r) => r.accountId)
          .filter((x): x is string => !!x && !accountName.has(x)),
      ),
    ];
    if (missing.length > 0) {
      const { data } = await sb.from("commercial_accounts").select("id, company_name").in("id", missing);
      for (const a of (data ?? []) as { id: string; company_name: string | null }[]) {
        accountName.set(a.id, a.company_name?.trim() || "Unnamed account");
      }
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

  for (const p of cashRows) {
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

    const issued = etDateOf(p.issuedAt);
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

    if (p.accountId) {
      const a = byAccount.get(p.accountId) ?? { collected: 0, lagWeighted: 0, lagAmount: 0 };
      a.collected += amount;
      if (issued) {
        a.lagWeighted += Math.max(0, daysBetween(issued, ymd)) * amount;
        a.lagAmount += amount;
      }
      byAccount.set(p.accountId, a);
    }
  }

  /**
   * BILLED MUST COVER BOTH LEDGERS, BECAUSE COLLECTED DOES.
   *
   * `collected` above folds in `aiaPaymentsAsCash`. This loop used to walk
   * `commercial_invoices` alone, so the rate divided two-ledger cash by
   * one-ledger billing. Measured 2026-10-16 over 2026-05-01 → 2026-10-16:
   * $974,243.71 collected ($194,048.68 invoices + $780,195.03 AIA) over
   * $151,722.86 invoiced = **642%**, under a sub-line explaining that "over
   * 100% just means older invoices landed". A reassuring caption on a 6.4×
   * error is why nobody reported it. Both ledgers: $1,386,221.66 billed, 70%.
   *
   * The definition is NOT rewritten here. `period-billing.ts` already folds
   * issued invoices plus each AIA application's billing INCREMENT, dated by
   * its billing period, and the dashboard's revenue trend runs on it — so a
   * second fold would be a second answer to "what did we bill in May".
   *
   * TAX BASIS (review session 2026-08-13, preserved): this is a COLLECTIONS
   * report, so both sides are with-tax. `collected` sums payments, which cover
   * the invoice TOTAL. So the invoice side is handed to the shared fold as
   * `total_cents`; measuring cash against pre-tax `subtotal_cents` reported
   * ~108% on a fully-paid taxable job. AIA needs no such swap — a certificate
   * carries the tax inside the contract price, with no separate tax line.
   */
  const periodInvoices: PeriodInvoice[] = invoices.map((i) => ({
    invoice_number: i.invoice_number,
    status: i.status,
    subtotal_cents: Number(i.total_cents) || 0,
    issued_at: i.issued_at,
    created_at: i.created_at,
    opportunity_id: i.opportunity_id,
  }));
  // Every deal that can carry billing: one with an invoice, one with a
  // certificate, or both. An AIA-only job has no invoice row at all, which is
  // exactly the money the old denominator was missing.
  const { data: aiaOppRows } = await sb
    .from("commercial_aia_applications")
    .select("opportunity_id")
    .is("deleted_at", null);
  const billingOppIds = [
    ...new Set(
      [
        ...invoices.map((i) => i.opportunity_id),
        ...((aiaOppRows ?? []) as { opportunity_id: string | null }[]).map((a) => a.opportunity_id),
      ].filter((x): x is string => !!x)
    ),
  ];
  const fullRange = { ...range, label: "cash flow" };
  const billing = await loadPeriodBilling(billingOppIds, periodInvoices, fullRange);
  const billed = billing.totalCents;

  // The chart's billed line, clipped to the range — see billedMonthsInRange.
  // The second fold is loaded only for a window whose BOTH edges are partial,
  // which no preset produces.
  const head = needsHeadFold(range)
    ? (
        await loadPeriodBilling(billingOppIds, periodInvoices, {
          fromYmd: range.fromYmd,
          toYmd: monthEnd(range.fromYmd.slice(0, 7)),
          label: "cash flow (head)",
        })
      ).totalCents
    : undefined;
  const billedByMonth = billedMonthsInRange(billing.monthly, billed, range, head);
  for (const [mKey, amt] of billedByMonth) {
    if (amt === 0 && !months.has(mKey)) continue;
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

/**
 * Recorded AIA payments, shaped like invoice payments so the collections maths
 * does not need a second branch.
 *
 * `issuedAt` comes from the shared `aiaIssuedAtFrom` ladder, so a certificate
 * ages the same way here as it does on AR aging. Tolerates the payments table
 * being absent (migration not yet applied): the report then reads exactly as
 * it did before AIA payments existed.
 */
async function aiaPaymentsAsCash(range: { fromYmd: string; toYmd: string }): Promise<
  {
    amount_cents: number;
    paid_at: string;
    method: string | null;
    issuedAt: string | null;
    accountId: string | null;
  }[]
> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_aia_payments")
    .select("application_id, amount_cents, paid_at, method")
    .is("deleted_at", null)
    .order("paid_at");
  if (error || !data || data.length === 0) return [];
  const rows = data as {
    application_id: string;
    amount_cents: number;
    paid_at: string;
    method: string | null;
  }[];

  // A PAYMENT ON A DELETED CERTIFICATE IS NOT CASH.
  //
  // `commercial_aia_payments` is filtered on its own `deleted_at`, but the
  // APPLICATION was not — so soft-deleting a certificate left its payments
  // counting as money in, exactly the way the invoice branch above refuses to
  // (`if (!inv) continue` — "voided or deleted invoice"). $0 on the book today;
  // it is one `.is()` away from being real the first time Mary deletes a
  // certificate somebody had already recorded a cheque against.
  const { data: apps } = await sb
    .from("commercial_aia_applications")
    .select("id, account_id, period_to, frozen_at")
    .is("deleted_at", null)
    .in("id", [...new Set(rows.map((r) => r.application_id))]);
  const appById = new Map(
    ((apps ?? []) as { id: string; account_id: string | null; period_to: string | null; frozen_at: string | null }[]).map(
      (a) => [a.id, a],
    ),
  );

  void range; // filtered by the shared loop, same as invoice payments
  return rows.flatMap((r) => {
    const app = appById.get(r.application_id);
    if (!app) return []; // deleted (or missing) certificate — same rule as a deleted invoice
    return [
      {
        amount_cents: Number(r.amount_cents) || 0,
        paid_at: r.paid_at,
        method: r.method,
        // THE SHARED AGING LADDER, not a local one. `period_to ?? frozen_at`
        // was a third definition of "when did this certificate go out", and it
        // disagreed with AR aging and the chase list on every normally-issued
        // application (where the platform's own issue instant is the honest
        // clock). `aiaIssuedAtFrom` keeps the back-entry rule that matters
        // here — a frozen_at more than a month after the period is a typing
        // date, so the period wins — without inventing a fourth answer.
        issuedAt: aiaIssuedAtFrom(app.frozen_at, app.period_to),
        accountId: app.account_id ?? null,
      },
    ];
  });
}
