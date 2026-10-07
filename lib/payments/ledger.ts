/**
 * The Payments tab, as data: which payments are in view, what they add up to,
 * and what the Excel export contains.
 *
 * Pure — rows in, numbers out — so the totals finance will make decisions from
 * are tested, not eyeballed. Money is integer cents throughout.
 *
 * The one rule that matters: BASE and FEE stay separate everywhere. Base is
 * what pays down the job and what Salesforce gets; the fee is the 3% on credit
 * cards, collected on top and never booked into the Payment In.
 */

export type LedgerPayment = {
  id: string;
  status: string;
  method: "card" | "ach";
  card_funding: string | null;
  work_order_id: string;
  work_order_number: string;
  customer_name: string | null;
  customer_email: string | null;
  milestone_label: string;
  base_cents: number;
  fee_cents: number;
  total_cents: number;
  stripe_fee_cents: number | null;
  livemode: boolean;
  payment_intent_id: string | null;
  sf_writeback_status: string | null;
  sf_transaction_id: string | null;
  payout_id: string | null;
  cleared_at: string | null;
  paid_at: string | null;
  created_at: string;
};

/** Statuses that are money: in flight, received, or given back. */
export const LEDGER_STATUSES = ["processing", "succeeded", "refunded"] as const;

// ─── How it was paid ────────────────────────────────────────────────────────

export type PaidWith = "bank" | "credit" | "debit" | "prepaid" | "card";
export const PAID_WITH_LABEL: Record<PaidWith, string> = {
  bank: "Bank (ACH)",
  credit: "Credit card",
  debit: "Debit card",
  prepaid: "Prepaid card",
  card: "Card (type unknown)",
};

export function paidWith(p: Pick<LedgerPayment, "method" | "card_funding">): PaidWith {
  if (p.method === "ach") return "bank";
  return p.card_funding === "credit" || p.card_funding === "debit" || p.card_funding === "prepaid" ? p.card_funding : "card";
}

// ─── Where it is ────────────────────────────────────────────────────────────

export type Stage = "processing" | "awaiting_payout" | "cleared" | "booked" | "booking_failed" | "refunded";
export const STAGE_LABEL: Record<Stage, string> = {
  processing: "Bank transfer clearing",
  awaiting_payout: "Paid · waiting for payout",
  cleared: "Cleared",
  booked: "Booked in Salesforce",
  booking_failed: "Salesforce booking failed",
  refunded: "Refunded",
};

export function stageOf(p: Pick<LedgerPayment, "status" | "sf_writeback_status" | "cleared_at">): Stage {
  if (p.status === "refunded") return "refunded";
  if (p.status === "processing") return "processing";
  if (p.sf_writeback_status === "written") return "booked";
  if (p.sf_writeback_status === "failed") return "booking_failed";
  // dry_run = cleared and drafted but deliberately not sent (test mode).
  if (p.cleared_at || p.sf_writeback_status === "dry_run") return "cleared";
  return "awaiting_payout";
}

/** The day the payment was made, in ET. Paid date when there is one; a bank
 *  transfer still clearing has only its start. */
export function paymentDateEt(p: Pick<LedgerPayment, "paid_at" | "created_at">): string {
  const iso = p.paid_at ?? p.created_at;
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

// ─── Date ranges ────────────────────────────────────────────────────────────

export type RangePreset = "month" | "last-month" | "quarter" | "fy" | "all" | "custom";
export const RANGE_LABEL: Record<RangePreset, string> = {
  month: "This month",
  "last-month": "Last month",
  quarter: "This quarter",
  fy: "This fiscal year",
  all: "All time",
  custom: "Custom",
};

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * Inclusive YYYY-MM-DD bounds for a preset, from today's ET date.
 * PPP's fiscal year runs Feb 1 → Jan 31 and is named for its start year;
 * quarters are Feb–Apr, May–Jul, Aug–Oct, Nov–Jan.
 */
export function rangeFor(
  preset: RangePreset,
  todayEt: string,
  custom?: { from?: string | null; to?: string | null },
): { from: string | null; to: string | null } {
  const [y, m] = todayEt.split("-").map(Number);
  switch (preset) {
    case "month":
      return { from: ymd(y, m, 1), to: ymd(y, m, lastDay(y, m)) };
    case "last-month": {
      const ly = m === 1 ? y - 1 : y;
      const lm = m === 1 ? 12 : m - 1;
      return { from: ymd(ly, lm, 1), to: ymd(ly, lm, lastDay(ly, lm)) };
    }
    case "quarter": {
      // Months since Feb 1 of the fiscal year, 0..11.
      const fyStartYear = m >= 2 ? y : y - 1;
      const offset = (m - 2 + 12) % 12;
      const qStartOffset = offset - (offset % 3);
      const startMonthIdx = 1 + qStartOffset; // 0-based month index, Feb = 1
      const sy = fyStartYear + Math.floor(startMonthIdx / 12);
      const sm = (startMonthIdx % 12) + 1;
      const endIdx = startMonthIdx + 2;
      const ey = fyStartYear + Math.floor(endIdx / 12);
      const em = (endIdx % 12) + 1;
      return { from: ymd(sy, sm, 1), to: ymd(ey, em, lastDay(ey, em)) };
    }
    case "fy": {
      const fyStartYear = m >= 2 ? y : y - 1;
      return { from: ymd(fyStartYear, 2, 1), to: ymd(fyStartYear + 1, 1, 31) };
    }
    case "custom": {
      const ok = (s?: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
      return { from: ok(custom?.from), to: ok(custom?.to) };
    }
    default:
      return { from: null, to: null };
  }
}

export type LedgerFilter = {
  from: string | null;
  to: string | null;
  paidWith?: PaidWith | "all";
  /** true = Stripe test-mode payments, false = real money. */
  livemode: boolean;
};

export function filterLedger<T extends LedgerPayment>(rows: T[], f: LedgerFilter): T[] {
  return rows.filter((p) => {
    if (!(LEDGER_STATUSES as readonly string[]).includes(p.status)) return false;
    if (p.livemode !== f.livemode) return false;
    const d = paymentDateEt(p);
    if (f.from && d < f.from) return false;
    if (f.to && d > f.to) return false;
    if (f.paidWith && f.paidWith !== "all" && paidWith(p) !== f.paidWith) return false;
    return true;
  });
}

// ─── Totals ─────────────────────────────────────────────────────────────────

export type LedgerTotals = {
  count: number;
  /** Paid by customers and not refunded. */
  baseCents: number;
  feeCents: number;
  totalCents: number;
  /** What Stripe charged PPP — known only for payments that have cleared. */
  stripeFeeCents: number;
  /** How many of the counted payments have a known Stripe cost. */
  stripeFeeKnownCount: number;
  /** Fees collected minus Stripe's cost, over payments where both are known. */
  feeNetCents: number;
  refundedCount: number;
  refundedCents: number;
  byPaidWith: Record<PaidWith, { count: number; baseCents: number; feeCents: number; totalCents: number }>;
};

export function totalsOf(rows: LedgerPayment[]): LedgerTotals {
  const by = Object.fromEntries(
    (Object.keys(PAID_WITH_LABEL) as PaidWith[]).map((k) => [k, { count: 0, baseCents: 0, feeCents: 0, totalCents: 0 }]),
  ) as LedgerTotals["byPaidWith"];
  const t: LedgerTotals = {
    count: 0,
    baseCents: 0,
    feeCents: 0,
    totalCents: 0,
    stripeFeeCents: 0,
    stripeFeeKnownCount: 0,
    feeNetCents: 0,
    refundedCount: 0,
    refundedCents: 0,
    byPaidWith: by,
  };
  for (const p of rows) {
    if (p.status === "refunded") {
      t.refundedCount++;
      t.refundedCents += p.total_cents;
      continue;
    }
    t.count++;
    t.baseCents += p.base_cents;
    t.feeCents += p.fee_cents;
    t.totalCents += p.total_cents;
    if (p.stripe_fee_cents != null) {
      t.stripeFeeCents += p.stripe_fee_cents;
      t.stripeFeeKnownCount++;
      t.feeNetCents += p.fee_cents - p.stripe_fee_cents;
    }
    const b = by[paidWith(p)];
    b.count++;
    b.baseCents += p.base_cents;
    b.feeCents += p.fee_cents;
    b.totalCents += p.total_cents;
  }
  return t;
}

// ─── Export ─────────────────────────────────────────────────────────────────

export const EXPORT_COLUMNS = [
  "Date paid",
  "Date cleared",
  "Customer",
  "Customer email",
  "Work Order",
  "Payment term",
  "Paid with",
  "Base amount (to Salesforce)",
  "Card fee collected (3%)",
  "Total charged",
  "Stripe processing cost",
  "Fee minus Stripe cost",
  "Status",
  "Stripe payment",
  "Stripe payout",
  "Salesforce Payment In",
] as const;

/** One spreadsheet row per payment. Dollars as numbers (not strings) so Excel can sum them. */
export function exportRow(p: LedgerPayment): (string | number | null)[] {
  const dollars = (c: number | null) => (c == null ? null : c / 100);
  return [
    paymentDateEt(p),
    p.cleared_at ? new Date(p.cleared_at).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) : null,
    p.customer_name,
    p.customer_email,
    p.work_order_number,
    p.milestone_label,
    PAID_WITH_LABEL[paidWith(p)],
    dollars(p.base_cents),
    dollars(p.fee_cents),
    dollars(p.total_cents),
    dollars(p.stripe_fee_cents),
    p.stripe_fee_cents == null ? null : dollars(p.fee_cents - p.stripe_fee_cents),
    STAGE_LABEL[stageOf(p)],
    p.payment_intent_id,
    p.payout_id,
    p.sf_transaction_id,
  ];
}

// ─── The tab's query string, shared by the page and the export ──────────────

export type LedgerQuery = {
  preset: RangePreset;
  from: string | null;
  to: string | null;
  paidWith: PaidWith | "all";
  livemode: boolean;
};

const PRESETS = Object.keys(RANGE_LABEL) as RangePreset[];
const PAID_WITHS = Object.keys(PAID_WITH_LABEL) as PaidWith[];

/**
 * Read ?range=&from=&to=&with=&mode= into a filter. The page and the Excel
 * export both call this, so the file always holds exactly what's on screen.
 * Unknown values fall back to defaults rather than erroring.
 */
export function parseLedgerQuery(
  sp: Record<string, string | string[] | undefined>,
  todayEt: string,
  defaultLive: boolean,
): LedgerQuery {
  const one = (k: string) => {
    const v = sp[k];
    return typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined;
  };
  const preset = PRESETS.includes(one("range") as RangePreset) ? (one("range") as RangePreset) : "month";
  const { from, to } = rangeFor(preset, todayEt, { from: one("from"), to: one("to") });
  const w = one("with");
  const paidWith = w && PAID_WITHS.includes(w as PaidWith) ? (w as PaidWith) : "all";
  const mode = one("mode");
  const livemode = mode === "live" ? true : mode === "test" ? false : defaultLive;
  return { preset, from, to, paidWith, livemode };
}

/** The query string for a LedgerQuery, with overrides — for links and the export URL. */
export function ledgerQueryString(q: LedgerQuery, over: Partial<LedgerQuery> = {}): string {
  const m = { ...q, ...over };
  const p = new URLSearchParams();
  p.set("range", m.preset);
  if (m.preset === "custom") {
    if (m.from) p.set("from", m.from);
    if (m.to) p.set("to", m.to);
  }
  if (m.paidWith !== "all") p.set("with", m.paidWith);
  p.set("mode", m.livemode ? "live" : "test");
  return p.toString();
}
