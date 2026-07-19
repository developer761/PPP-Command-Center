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
  // Reject malformed atDate — the resolution logic below does a raw
  // string compare (`eff <= today`) which silently misbehaves on
  // "tomorrow" or "2026-13-40". Better to fail fast than to write an
  // override that resolves against a wrong anchor.
  if (atDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(atDate)) {
    throw new Error(
      `resolveProductPrice: atDate must be YYYY-MM-DD, got ${JSON.stringify(atDate)}`
    );
  }
  // Anchor "today" in America/New_York — PPP's operational timezone.
  const today =
    atDate ??
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

  // F.6 audit fix: look up parent_product_id so parent-level customer
  // overrides can be inherited by variations (e.g. "Tomco gets 10% off
  // HM Frame & Wood Door" applies to every variation of that parent).
  // One extra round-trip vs the pre-F.6 fetch, worth it for correctness.
  const { data: product } = await sb
    .from("commercial_products")
    .select("default_unit_price_cents, parent_product_id")
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
  const productRow = product as {
    default_unit_price_cents: number;
    parent_product_id: string | null;
  };

  // First: customer override on the SPECIFIC product (variation-level
  // override wins over parent-level override — most specific first).
  if (accountId) {
    const productIdsToCheck = productRow.parent_product_id
      ? [productId, productRow.parent_product_id]
      : [productId];
    const { data: overrides } = await sb
      .from("commercial_customer_prices")
      .select("id, product_id, unit_price_cents, effective_from")
      .eq("account_id", accountId)
      .in("product_id", productIdsToCheck)
      .order("effective_from", { ascending: false, nullsFirst: false })
      .limit(100);
    // Walk product_id specificity: try the variation's own overrides
    // first (most specific), then the parent's (inherited).
    for (const pid of productIdsToCheck) {
      const applicable = (overrides ?? [])
        .filter((r) => (r as { product_id: string }).product_id === pid)
        .find((row) => {
          const eff = (row as { effective_from: string | null }).effective_from;
          if (!eff) return true;
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
  }

  // Fall back to catalog default.
  return {
    unit_price_cents: productRow.default_unit_price_cents,
    source: "catalog_default",
    override_id: null,
  };
}
