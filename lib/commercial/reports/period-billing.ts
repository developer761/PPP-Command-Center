import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { lineCompletedStoredCents } from "@/lib/commercial/aia/constants";
import { isSupersededByAia } from "@/lib/commercial/invoices/carryover";
import { etDateOf } from "@/lib/date-et";
import type { RangeResult } from "./presets";

/**
 * BILLED REVENUE IN A PERIOD — both ledgers, dated by when they were billed.
 *
 * The dashboard's "Gross revenue" used to be lifetime only, and its monthly
 * trend counted invoices alone, bucketed by `created_at`. Two consequences Alex
 * could see on one screen: a job billed only through AIA (G702/G703) raised
 * Gross and never appeared in the trend, and a draft created in September and
 * sent in October landed in September.
 *
 * Here, for a date range:
 *   · Invoices — issued (not draft, not void), pre-tax `subtotal_cents`, dated
 *     by `issued_at` (falling back to `created_at` only where an issued invoice
 *     carries no issue date).
 *   · AIA — each ISSUED application (submitted / paid) contributes the work it
 *     ADDED: its completed-and-stored to date minus the previous issued
 *     application's. Dated by its BILLING PERIOD (`period_to`), falling back to
 *     `frozen_at` only when no period was recorded.
 *
 *     Deliberately NOT `aiaIssuedAtFrom`, which prefers `frozen_at`. That
 *     ladder answers "when did this become payable" for aging, and frozen_at
 *     is the moment the application was issued IN THE PLATFORM. Measured
 *     2026-10-15: all 39 issued applications were frozen in Sep–Oct 2026,
 *     because Mary back-entered each job's history when Tomco moved over — 25
 *     of them more than 30 days after their period (median 43, max 250). Dated
 *     by frozen_at, eight months of AIA billing landed in Q3 FY26 and "This
 *     quarter" read $1.14M. Revenue belongs to the period it was billed for.
 *
 * Over all time the AIA increments telescope to the latest issued
 * application's completed-to-date, so "All time" here equals the lifetime
 * `billedContractCents` the project rows carry. That identity is the test that
 * this module and `projects/db.ts` describe the same money.
 *
 * Pre-tax and gross of retainage, like every other "billed" figure: retainage
 * is earned revenue that is merely held.
 *
 * And the `SF-####` carry-over invoice on a job that also has issued
 * certificates is NOT added: it is the same money as those certificates (see
 * lib/commercial/invoices/carryover.ts). `projects/db.ts` already skips it, so
 * without the same guard here the identity above breaks the first time such
 * an invoice is live — and "Gross revenue" counts the job twice.
 */

export type PeriodInvoice = {
  status: string;
  subtotal_cents: number;
  issued_at?: string | null;
  created_at: string | null;
  opportunity_id?: string | null;
  /** For the carry-over guard. A caller that drops it loses the guard, so
   *  it is required rather than optional. */
  invoice_number: string | null;
};

export type PeriodAiaApp = {
  id: string;
  opportunity_id: string;
  application_number: number;
  status: string;
  frozen_at: string | null;
  period_to: string | null;
};

export type PeriodBilling = {
  /** Billed in the range, per deal (pre-tax, both ledgers). */
  byOpp: Map<string, number>;
  /** Σ byOpp. */
  totalCents: number;
  /** EVERY month ever billed ("YYYY-MM" → cents), not range-limited, so the
   *  trend chart can draw context around a short range. */
  monthly: Map<string, number>;
};

const ISSUED_AIA = new Set(["submitted", "paid"]);

function inRange(ymd: string | null, range: RangeResult | null): boolean {
  if (!range) return true;
  if (!ymd) return false;
  return ymd >= range.fromYmd && ymd <= range.toYmd;
}

/**
 * Pure fold — the rules, without a database. `completedByApp` is each
 * application's completed-and-stored to date (Σ lineCompletedStoredCents).
 */
export function foldPeriodBilling(
  invoices: PeriodInvoice[],
  apps: PeriodAiaApp[],
  completedByApp: Map<string, number>,
  range: RangeResult | null,
  oppIds?: Set<string>
): PeriodBilling {
  const byOpp = new Map<string, number>();
  const monthly = new Map<string, number>();
  const add = (oppId: string, ymd: string | null, cents: number) => {
    if (ymd) monthly.set(ymd.slice(0, 7), (monthly.get(ymd.slice(0, 7)) ?? 0) + cents);
    if (inRange(ymd, range)) byOpp.set(oppId, (byOpp.get(oppId) ?? 0) + cents);
  };

  // Deals with an issued certificate — the same condition `dealsBilledViaAia`
  // reads, taken from the applications already in hand.
  const billedViaAia = new Set(
    apps.filter((a) => ISSUED_AIA.has(a.status)).map((a) => a.opportunity_id)
  );

  for (const inv of invoices) {
    if (inv.status === "draft" || inv.status === "void") continue;
    if (!inv.opportunity_id || (oppIds && !oppIds.has(inv.opportunity_id))) continue;
    if (isSupersededByAia(inv, billedViaAia)) continue;
    add(inv.opportunity_id, etDateOf(inv.issued_at ?? inv.created_at), Number(inv.subtotal_cents ?? 0));
  }

  // Issued applications per deal, in billing order.
  const issuedByOpp = new Map<string, PeriodAiaApp[]>();
  for (const a of apps) {
    if (!ISSUED_AIA.has(a.status)) continue;
    if (oppIds && !oppIds.has(a.opportunity_id)) continue;
    const list = issuedByOpp.get(a.opportunity_id) ?? [];
    list.push(a);
    issuedByOpp.set(a.opportunity_id, list);
  }
  for (const [oppId, list] of issuedByOpp) {
    list.sort((x, y) => x.application_number - y.application_number);
    let previous = 0;
    for (const a of list) {
      const completed = completedByApp.get(a.id) ?? 0;
      add(oppId, a.period_to ? a.period_to.slice(0, 10) : etDateOf(a.frozen_at), completed - previous);
      previous = completed;
    }
  }

  let totalCents = 0;
  for (const v of byOpp.values()) totalCents += v;
  return { byOpp, totalCents, monthly };
}

/** Load and fold. `invoices` is passed in because every caller already has them. */
export async function loadPeriodBilling(
  oppIds: string[],
  invoices: PeriodInvoice[],
  range: RangeResult | null
): Promise<PeriodBilling> {
  const ids = [...new Set(oppIds.filter(Boolean))];
  const scope = new Set(ids);
  if (ids.length === 0) return foldPeriodBilling([], [], new Map(), range, scope);
  const sb = commercialDb();
  const apps = await paginateAll<PeriodAiaApp>(() =>
    sb
      .from("commercial_aia_applications")
      .select("id, opportunity_id, application_number, status, frozen_at, period_to")
      .in("opportunity_id", ids)
      .is("deleted_at", null)
      .order("id", { ascending: true })
  );
  const issuedIds = apps.filter((a) => ISSUED_AIA.has(a.status)).map((a) => a.id);
  const completedByApp = new Map<string, number>();
  if (issuedIds.length > 0) {
    const lines = await paginateAll<{
      application_id: string;
      scheduled_value_cents: number;
      from_previous_cents: number;
      this_period_cents: number;
      materials_stored_cents: number;
    }>(() =>
      sb
        .from("commercial_aia_line_items")
        .select("application_id, scheduled_value_cents, from_previous_cents, this_period_cents, materials_stored_cents")
        .in("application_id", issuedIds)
        .order("id", { ascending: true })
    );
    for (const l of lines) {
      completedByApp.set(l.application_id, (completedByApp.get(l.application_id) ?? 0) + lineCompletedStoredCents(l));
    }
  }
  return foldPeriodBilling(invoices, apps, completedByApp, range, scope);
}

/**
 * The trend chart's months for a range: the months the range covers, padded
 * back to at least six so "This month" still draws a trend, and capped at 24
 * (the most recent) so "All time" stays legible on a phone.
 * Values in $K for TrendChart's `currency-k`.
 */
const CHART_MIN_MONTHS = 6;
const CHART_MAX_MONTHS = 24;

export function monthlyPointsFor(
  monthly: Map<string, number>,
  range: RangeResult | null,
  todayYmd: string
): { label: string; value: number; key: string }[] {
  const minMonths = CHART_MIN_MONTHS;
  const maxMonths = CHART_MAX_MONTHS;
  const endKey = (range?.toYmd ?? todayYmd).slice(0, 7);
  const firstBilled = [...monthly.keys()].sort()[0] ?? endKey;
  const startKey = (range?.fromYmd ?? `${firstBilled}-01`).slice(0, 7);
  const toIndex = (k: string) => Number(k.slice(0, 4)) * 12 + Number(k.slice(5, 7)) - 1;
  const end = toIndex(endKey);
  let start = Math.min(toIndex(startKey), end - (minMonths - 1));
  start = Math.max(start, end - (maxMonths - 1));
  const out: { label: string; value: number; key: string }[] = [];
  for (let i = start; i <= end; i++) {
    const y = Math.floor(i / 12);
    const m = (i % 12) + 1;
    const key = `${y}-${String(m).padStart(2, "0")}`;
    const short = new Date(Date.UTC(2000, m - 1, 1)).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
    // The year only where it changes, so a 12-month FY reads "Feb '26 … Jan '27".
    const label = m === 1 || i === start ? `${short} '${String(y).slice(-2)}` : short;
    out.push({ key, label, value: (monthly.get(key) ?? 0) / 100000 });
  }
  return out;
}
