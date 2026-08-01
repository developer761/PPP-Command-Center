/**
 * Shared monthly-billed series (2026-08 audit) — one implementation for the
 * dashboard, account Profitability, and account "Billed / month" so all three
 * bucket the SAME way. Two things the ad-hoc copies got wrong:
 *
 *  1. Tax basis — "billed" is a PRE-tax concept platform-wide (contract is
 *     pre-tax), so we sum `subtotal_cents`, never `total_cents` (which folds in
 *     pass-through sales tax and made one chart disagree with the others).
 *  2. Month attribution — buckets are computed in America/New_York, the tz the
 *     whole app renders in. Bucketing by the server's UTC month boundaries put
 *     an invoice created at, say, Mar 31 10pm ET (Apr 1 02:00 UTC) into April
 *     while every other surface labels it March.
 *
 * Issued-only (draft = not billed yet, void = never billed). Values are returned
 * in $K (cents / 100000) so they feed TrendChart's `yFormat="currency-k"`.
 */

export type MonthlyPoint = { label: string; value: number };

type MinimalInvoice = {
  status: string;
  subtotal_cents: number;
  created_at: string | null;
  opportunity_id?: string;
};

/** ET year+month for an ISO instant (e.g. {y:2026, m:3} for March 2026). */
function etYearMonth(iso: string): { y: number; m: number } | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
  }).formatToParts(new Date(t));
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return null;
  return { y, m };
}

/**
 * @param invoices  all invoices (any status; we filter issued-only here)
 * @param opts.months  how many trailing months to include (default 6)
 * @param opts.oppIds  if given, only count invoices whose opportunity_id is in
 *                     the set (so the dashboard can scope to project opps)
 * @param opts.nowIso  the "current month" anchor as an ISO instant — pass a
 *                     server timestamp; buckets are the trailing N ET months
 *                     ending in that instant's ET month.
 */
export function monthlyBilledSeries(
  invoices: MinimalInvoice[],
  opts: { months?: number; oppIds?: Set<string>; nowIso: string }
): MonthlyPoint[] {
  const months = opts.months ?? 6;
  const anchor = etYearMonth(opts.nowIso) ?? { y: 1970, m: 1 };
  // Build the trailing month buckets (oldest → newest) as {y, m} keys.
  const buckets: { y: number; m: number; label: string; cents: number }[] = [];
  for (let back = months - 1; back >= 0; back--) {
    // Zero-based month math, then normalize.
    const raw = anchor.m - 1 - back; // 0-based, can go negative
    const y = anchor.y + Math.floor(raw / 12);
    const m = ((raw % 12) + 12) % 12; // 0-based month
    const label = new Date(Date.UTC(2000, m, 1)).toLocaleString("en-US", {
      month: "short",
      timeZone: "UTC",
    });
    buckets.push({ y, m: m + 1, label, cents: 0 });
  }
  const idxByKey = new Map(buckets.map((b, i) => [`${b.y}-${b.m}`, i]));

  for (const inv of invoices) {
    if (inv.status === "void" || inv.status === "draft") continue;
    if (opts.oppIds && (inv.opportunity_id == null || !opts.oppIds.has(inv.opportunity_id))) continue;
    if (!inv.created_at) continue;
    const ym = etYearMonth(inv.created_at);
    if (!ym) continue;
    const idx = idxByKey.get(`${ym.y}-${ym.m}`);
    if (idx == null) continue;
    buckets[idx].cents += Number(inv.subtotal_cents ?? 0);
  }

  return buckets.map((b) => ({ label: b.label, value: b.cents / 100000 }));
}
