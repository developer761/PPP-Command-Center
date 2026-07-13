/**
 * Product resolution endpoint — used by <ProductPicker> when the user
 * picks a SKU on the invoice line-item form.
 *
 * GET /api/commercial/products/resolve?product_id=UUID&account_id=UUID
 *
 * Returns:
 *   { ok: true, name, unit, unit_price_cents, source, applied }
 *
 * `source` is "customer_override" when a `commercial_customer_prices`
 * row applied, "catalog_default" otherwise. `applied` is a short human
 * label the client can render next to the price ("Tomco rate" or
 * "catalog default").
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  getProfileByUserId,
  platformAccess,
} from "@/lib/auth/profile";
import { getProduct } from "@/lib/commercial/products/db";
import { resolveProductPrice } from "@/lib/commercial/products/pricing";

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const profile = await getProfileByUserId(user.id);
  const access = platformAccess(profile);
  if (!access.hasNewPlatform)
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const productId = url.searchParams.get("product_id");
  const accountId = url.searchParams.get("account_id");
  if (!productId || !UUID_RE.test(productId))
    return NextResponse.json({ error: "bad_product_id" }, { status: 400 });
  if (accountId && !UUID_RE.test(accountId))
    return NextResponse.json({ error: "bad_account_id" }, { status: 400 });

  const [product, resolved] = await Promise.all([
    getProduct(productId),
    resolveProductPrice({
      productId,
      accountId: accountId ?? null,
    }),
  ]);
  if (!product)
    return NextResponse.json({ error: "product_not_found" }, { status: 404 });

  return NextResponse.json({
    ok: true,
    name: product.name,
    unit: product.unit,
    unit_price_cents: resolved.unit_price_cents,
    source: resolved.source,
    applied:
      resolved.source === "customer_override"
        ? "customer rate"
        : "catalog default",
  });
}
