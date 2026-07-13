/**
 * Phase D price resolution — single source of truth for "what does
 * product X cost customer Y today?"
 *
 * Rule:
 *   1. If accountId is given AND a `commercial_customer_prices` row
 *      exists for (account, product) with `effective_from <= atDate`,
 *      use the most-recent-effective row's `unit_price_cents`.
 *   2. Otherwise fall back to `commercial_products.default_unit_price_cents`.
 *
 * Callers that need the resolved price (e.g. addLineItemAction when
 * the user picks from ProductPicker) should call resolveProductPrice
 * once and snapshot the result — do NOT re-resolve on every read,
 * because historical invoices must stay stable when catalog prices
 * change later.
 */

import { commercialDb } from "@/lib/commercial/db";

export type ResolvedPrice = {
  /** The unit price to use, in cents. Never null (falls back to 0 if
   *  the product doesn't exist). */
  unit_price_cents: number;
  /** How the price was derived. */
  source: "customer_override" | "catalog_default" | "product_missing";
  /** If `source === "customer_override"`, the row id that provided it. */
  override_id: string | null;
};

export async function resolveProductPrice({
  productId,
  accountId,
  atDate,
}: {
  productId: string;
  accountId?: string | null;
  /** YYYY-MM-DD; defaults to today (ET). */
  atDate?: string;
}): Promise<ResolvedPrice> {
  const sb = commercialDb();
  // Anchor "today" in America/New_York — PPP's operational timezone.
  const today =
    atDate ??
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

  // First: customer override, most recent effective_from that's still
  // in effect. NULL effective_from = "always" and sorts as oldest via
  // COALESCE below so a dated override wins if both exist.
  if (accountId) {
    const { data: overrides } = await sb
      .from("commercial_customer_prices")
      .select("id, unit_price_cents, effective_from")
      .eq("account_id", accountId)
      .eq("product_id", productId)
      .order("effective_from", { ascending: false, nullsFirst: false })
      .limit(50);
    const applicable = (overrides ?? []).find((row) => {
      const eff = (row as { effective_from: string | null }).effective_from;
      if (!eff) return true; // "always"
      return eff <= today;
    }) as { id: string; unit_price_cents: number } | undefined;
    if (applicable) {
      return {
        unit_price_cents: applicable.unit_price_cents,
        source: "customer_override",
        override_id: applicable.id,
      };
    }
  }

  // Fall back to catalog default.
  const { data: product } = await sb
    .from("commercial_products")
    .select("default_unit_price_cents")
    .eq("id", productId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!product) {
    return {
      unit_price_cents: 0,
      source: "product_missing",
      override_id: null,
    };
  }
  return {
    unit_price_cents: (product as { default_unit_price_cents: number })
      .default_unit_price_cents,
    source: "catalog_default",
    override_id: null,
  };
}
