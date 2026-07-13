import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import {
  getProduct,
  updateProduct,
  softDeleteProduct,
  listCustomerPricesForProduct,
  upsertCustomerPrice,
  deleteCustomerPrice,
} from "@/lib/commercial/products/db";
import {
  PRODUCT_CATEGORIES,
  PRODUCT_UNITS,
  productCategoryLabel,
  productUnitLabel,
} from "@/lib/commercial/products/constants";
import { listCommercialAccounts } from "@/lib/commercial/accounts/db";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";

/**
 * Product detail — edit basic fields + per-account price overrides.
 *
 * Two forms on one page:
 *   1. Product core (name/sku/category/unit/price/cost/notes/active flag)
 *   2. Customer price add + list of existing overrides
 *
 * Every mutation is admin-gated. Redirects preserve the product id +
 * carry ?ok / ?error markers so the user sees a clear result.
 */

export const dynamic = "force-dynamic";

function parseDollarsToCents(raw: FormDataEntryValue | null): number | null {
  if (raw === null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const num = Number(trimmed.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num * 100);
}

function formatDollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function centsToDollarStr(cents: number | null): string {
  if (cents === null) return "";
  return (cents / 100).toFixed(2);
}

function detailPath(id: string, marker?: string): string {
  return `/commercial/pre-job/products/${id}${marker ? "?" + marker : ""}`;
}

async function guardAdmin(): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(user.email);
  if (!isAdmin) redirect("/commercial/pre-job/products");
  return user.id;
}

async function saveCoreAction(formData: FormData) {
  "use server";
  const userId = await guardAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/commercial/pre-job/products");

  const price = parseDollarsToCents(formData.get("default_unit_price"));
  const costRaw = formData.get("default_unit_cost");
  const cost = parseDollarsToCents(costRaw);
  // Distinguish "cleared" (empty string) from "not provided" so we can
  // preserve NULL. If the field was left empty, pass null; otherwise
  // pass the parsed cents.
  const costPayload =
    costRaw !== null && String(costRaw).trim() === "" ? null : cost;
  if (price === null)
    redirect(
      detailPath(
        id,
        "error=" +
          encodeURIComponent("Default price must be a positive dollar amount.")
      )
    );

  const result = await updateProduct({
    id,
    sku: String(formData.get("sku") ?? "").trim(),
    name: String(formData.get("name") ?? "").trim(),
    category: String(formData.get("category") ?? "other"),
    unit: String(formData.get("unit") ?? "each"),
    default_unit_price_cents: price,
    default_unit_cost_cents: costPayload,
    notes: String(formData.get("notes") ?? "").trim() || null,
    is_active: formData.get("is_active") === "on",
    updated_by_user_id: userId,
  });
  if (!result.ok) {
    redirect(detailPath(id, "error=" + encodeURIComponent(result.error)));
  }
  redirect(detailPath(id, "ok=updated"));
}

async function archiveAction(formData: FormData) {
  "use server";
  const userId = await guardAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/commercial/pre-job/products");
  const result = await softDeleteProduct(id, userId);
  if (!result.ok) {
    redirect(detailPath(id, "error=" + encodeURIComponent(result.error)));
  }
  redirect("/commercial/pre-job/products?ok=archived");
}

async function addPriceAction(formData: FormData) {
  "use server";
  const userId = await guardAdmin();
  const productId = String(formData.get("product_id") ?? "");
  const accountId = String(formData.get("account_id") ?? "");
  const price = parseDollarsToCents(formData.get("unit_price"));
  const effectiveFromRaw = String(formData.get("effective_from") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;
  if (!productId)
    redirect(
      "/commercial/pre-job/products?error=" +
        encodeURIComponent("Missing product id.")
    );
  if (!accountId)
    redirect(
      detailPath(
        productId,
        "error=" + encodeURIComponent("Pick an account for this override.")
      )
    );
  if (price === null)
    redirect(
      detailPath(
        productId,
        "error=" + encodeURIComponent("Enter a valid unit price.")
      )
    );
  const result = await upsertCustomerPrice({
    product_id: productId,
    account_id: accountId,
    unit_price_cents: price,
    effective_from: effectiveFromRaw || null,
    notes,
    actor_user_id: userId,
  });
  if (!result.ok) {
    redirect(detailPath(productId, "error=" + encodeURIComponent(result.error)));
  }
  redirect(detailPath(productId, "ok=price_saved"));
}

async function removePriceAction(formData: FormData) {
  "use server";
  const userId = await guardAdmin();
  const productId = String(formData.get("product_id") ?? "");
  const priceId = String(formData.get("price_id") ?? "");
  if (!productId || !priceId)
    redirect("/commercial/pre-job/products");
  const result = await deleteCustomerPrice(priceId, userId);
  if (!result.ok) {
    redirect(detailPath(productId, "error=" + encodeURIComponent(result.error)));
  }
  redirect(detailPath(productId, "ok=price_removed"));
}

export default async function ProductDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  const access = platformAccess(profile);
  if (!access.hasNewPlatform) redirect("/commercial");
  const isAdmin = profile?.is_admin ?? isAdminEmail(user.email);

  const { id } = await params;
  const sp = await searchParams;

  const [product, customerPrices, accounts] = await Promise.all([
    getProduct(id),
    listCustomerPricesForProduct(id),
    listCommercialAccounts(),
  ]);
  if (!product) notFound();

  // Map account_id → account for override rendering.
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  return (
    <div className="max-w-3xl space-y-5">
      <header>
        <span aria-hidden className="block h-[3px] w-10 rounded-full mb-3 bg-cc-brand-600" />
        <div className="mb-2 flex items-center gap-2">
          <Link
            href="/commercial/pre-job/products"
            className="text-[13px] font-medium text-ppp-charcoal-500 hover:text-ppp-charcoal"
          >
            ← Products
          </Link>
        </div>
        <div className="flex items-baseline flex-wrap gap-2">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ppp-charcoal">
            {product.name}
          </h1>
          <span className="inline-flex items-center text-[10.5px] font-bold tracking-widest uppercase text-ppp-charcoal-500 bg-ppp-charcoal-50 border border-ppp-charcoal-100 px-1.5 py-0.5 rounded font-mono">
            {product.sku}
          </span>
          {!product.is_active && (
            <span className="inline-flex items-center text-[10.5px] font-bold tracking-widest uppercase text-amber-800 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
              archived
            </span>
          )}
        </div>
        <p className="text-sm text-ppp-charcoal-500 mt-1">
          {productCategoryLabel(product.category)} · per {productUnitLabel(product.unit)} ·
          default {formatDollars(product.default_unit_price_cents)}
          {product.default_unit_cost_cents !== null && (
            <> · cost {formatDollars(product.default_unit_cost_cents)}</>
          )}
        </p>
      </header>

      {sp.ok && (
        <div className="bg-cc-brand-50 border border-cc-brand-200 rounded-xl px-4 py-2.5 text-sm text-cc-brand-800">
          {sp.ok === "created" && "Product created."}
          {sp.ok === "updated" && "Product updated."}
          {sp.ok === "price_saved" && "Customer price saved."}
          {sp.ok === "price_removed" && "Customer price removed."}
        </div>
      )}
      {sp.error && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-2.5 text-sm text-rose-800">
          {decodeURIComponent(sp.error)}
        </div>
      )}

      {/* Core edit form */}
      <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 sm:p-6">
        <h2 className="text-sm font-semibold text-ppp-charcoal mb-4">
          Product details
        </h2>
        {isAdmin ? (
          <form action={saveCoreAction} className="space-y-4">
            <input type="hidden" name="id" value={product.id} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="block">
                <span className="block text-[12px] font-semibold text-ppp-charcoal-700 mb-1">
                  SKU <span className="text-rose-600">*</span>
                </span>
                <input
                  type="text"
                  name="sku"
                  required
                  maxLength={100}
                  defaultValue={product.sku}
                  className="w-full px-3 py-2.5 rounded-lg border border-ppp-charcoal-200 text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[44px] font-mono"
                />
              </label>
              <label className="block">
                <span className="block text-[12px] font-semibold text-ppp-charcoal-700 mb-1">
                  Name <span className="text-rose-600">*</span>
                </span>
                <input
                  type="text"
                  name="name"
                  required
                  maxLength={300}
                  defaultValue={product.name}
                  className="w-full px-3 py-2.5 rounded-lg border border-ppp-charcoal-200 text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[44px]"
                />
              </label>
              <label className="block">
                <span className="block text-[12px] font-semibold text-ppp-charcoal-700 mb-1">
                  Category
                </span>
                <select
                  name="category"
                  defaultValue={product.category}
                  className="w-full px-3 py-2.5 rounded-lg border border-ppp-charcoal-200 text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[44px]"
                >
                  {PRODUCT_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {productCategoryLabel(c)}
                    </option>
                  ))}
                  {!(PRODUCT_CATEGORIES as readonly string[]).includes(
                    product.category
                  ) && (
                    <option value={product.category}>{product.category}</option>
                  )}
                </select>
              </label>
              <label className="block">
                <span className="block text-[12px] font-semibold text-ppp-charcoal-700 mb-1">
                  Unit
                </span>
                <select
                  name="unit"
                  defaultValue={product.unit}
                  className="w-full px-3 py-2.5 rounded-lg border border-ppp-charcoal-200 text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[44px]"
                >
                  {PRODUCT_UNITS.map((u) => (
                    <option key={u} value={u}>
                      {productUnitLabel(u)}
                    </option>
                  ))}
                  {!(PRODUCT_UNITS as readonly string[]).includes(
                    product.unit
                  ) && <option value={product.unit}>{product.unit}</option>}
                </select>
              </label>
              <label className="block">
                <span className="block text-[12px] font-semibold text-ppp-charcoal-700 mb-1">
                  Default price ($) <span className="text-rose-600">*</span>
                </span>
                <input
                  type="text"
                  name="default_unit_price"
                  required
                  inputMode="decimal"
                  defaultValue={centsToDollarStr(product.default_unit_price_cents)}
                  className="w-full px-3 py-2.5 rounded-lg border border-ppp-charcoal-200 text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[44px] tabular-nums"
                />
              </label>
              <label className="block">
                <span className="block text-[12px] font-semibold text-ppp-charcoal-700 mb-1">
                  PPP cost ($)
                </span>
                <input
                  type="text"
                  name="default_unit_cost"
                  inputMode="decimal"
                  defaultValue={centsToDollarStr(product.default_unit_cost_cents)}
                  placeholder="—"
                  className="w-full px-3 py-2.5 rounded-lg border border-ppp-charcoal-200 text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[44px] tabular-nums"
                />
              </label>
            </div>
            <label className="block">
              <span className="block text-[12px] font-semibold text-ppp-charcoal-700 mb-1">
                Notes
              </span>
              <textarea
                name="notes"
                maxLength={2000}
                rows={2}
                defaultValue={product.notes ?? ""}
                className="w-full px-3 py-2.5 rounded-lg border border-ppp-charcoal-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 resize-y"
              />
            </label>
            <label className="inline-flex items-center gap-2 text-[13px] text-ppp-charcoal-700 min-h-[44px]">
              <input
                type="checkbox"
                name="is_active"
                defaultChecked={product.is_active}
                className="h-4 w-4 rounded border-ppp-charcoal-300 text-cc-brand-600 focus:ring-cc-brand-500"
              />
              Active (shown in the picker)
            </label>
            <div className="flex flex-col sm:flex-row-reverse gap-2 pt-2 border-t border-ppp-charcoal-100">
              <PendingSubmitButton
                className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 disabled:opacity-60 disabled:cursor-not-allowed min-h-[44px]"
                pendingLabel="Saving…"
              >
                Save changes
              </PendingSubmitButton>
              <Link
                href="/commercial/pre-job/products"
                className="inline-flex items-center justify-center px-4 py-2.5 rounded-lg border border-ppp-charcoal-200 text-sm font-medium text-ppp-charcoal hover:bg-ppp-charcoal-50 min-h-[44px]"
              >
                Cancel
              </Link>
            </div>
          </form>
        ) : (
          <p className="text-sm text-ppp-charcoal-500">
            Only admins can edit this product.
          </p>
        )}
      </section>

      {/* Customer-specific prices */}
      <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 sm:p-6">
        <div className="flex items-baseline justify-between gap-3 mb-3 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-ppp-charcoal">
              Customer-specific prices
            </h2>
            <p className="text-[12px] text-ppp-charcoal-500 mt-0.5">
              Tomco-style negotiated rates. When a line item is added for
              an account with an override, the override wins.
            </p>
          </div>
          <span className="inline-flex items-center text-[10px] font-bold tracking-widest uppercase text-cc-brand-700 bg-cc-brand-50 border border-cc-brand-200 px-2 py-0.5 rounded">
            {customerPrices.length} override{customerPrices.length === 1 ? "" : "s"}
          </span>
        </div>

        {customerPrices.length === 0 ? (
          <p className="text-[13px] text-ppp-charcoal-500 mb-4">
            No overrides yet. The default price above applies to every
            account.
          </p>
        ) : (
          <ul className="space-y-2 mb-4">
            {customerPrices.map((row) => {
              const acct = accountById.get(row.account_id);
              return (
                <li
                  key={row.id}
                  className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 border border-ppp-charcoal-100 rounded-lg p-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-[13.5px] font-semibold text-ppp-charcoal truncate">
                      {acct?.company_name ?? "(account removed)"}
                    </div>
                    <div className="text-[11.5px] text-ppp-charcoal-500 flex items-center gap-x-2 flex-wrap">
                      <span className="tabular-nums font-semibold text-ppp-charcoal">
                        {formatDollars(row.unit_price_cents)}
                      </span>
                      <span aria-hidden className="text-ppp-charcoal-300">·</span>
                      <span>
                        {row.effective_from
                          ? `from ${row.effective_from}`
                          : "always"}
                      </span>
                      {row.notes && (
                        <>
                          <span aria-hidden className="text-ppp-charcoal-300">·</span>
                          <span className="truncate">{row.notes}</span>
                        </>
                      )}
                    </div>
                  </div>
                  {isAdmin && (
                    <form action={removePriceAction}>
                      <input type="hidden" name="product_id" value={product.id} />
                      <input type="hidden" name="price_id" value={row.id} />
                      <PendingSubmitButton
                        className="inline-flex items-center px-3 py-2 rounded-md border border-rose-200 text-rose-800 text-xs font-medium hover:bg-rose-50 min-h-[40px]"
                        pendingLabel="Removing…"
                      >
                        Remove
                      </PendingSubmitButton>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {isAdmin && (
          <form
            action={addPriceAction}
            className="border-t border-ppp-charcoal-100 pt-4 space-y-3"
          >
            <input type="hidden" name="product_id" value={product.id} />
            <h3 className="text-[13px] font-semibold text-ppp-charcoal-700">
              Add or update override
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block sm:col-span-2">
                <span className="block text-[11.5px] font-semibold text-ppp-charcoal-700 mb-1">
                  Account <span className="text-rose-600">*</span>
                </span>
                <select
                  name="account_id"
                  required
                  defaultValue=""
                  className="w-full px-3 py-2.5 rounded-lg border border-ppp-charcoal-200 text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[44px]"
                >
                  <option value="" disabled>
                    Pick an account…
                  </option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.company_name}
                    </option>
                  ))}
                </select>
                <span className="block mt-1 text-[11px] text-ppp-charcoal-500">
                  Saving on an account that already has an override at
                  the same date will update the existing row.
                </span>
              </label>
              <label className="block">
                <span className="block text-[11.5px] font-semibold text-ppp-charcoal-700 mb-1">
                  Unit price ($) <span className="text-rose-600">*</span>
                </span>
                <input
                  type="text"
                  name="unit_price"
                  required
                  inputMode="decimal"
                  placeholder="65.00"
                  className="w-full px-3 py-2.5 rounded-lg border border-ppp-charcoal-200 text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[44px] tabular-nums"
                />
              </label>
              <label className="block">
                <span className="block text-[11.5px] font-semibold text-ppp-charcoal-700 mb-1">
                  Effective from
                </span>
                <input
                  type="date"
                  name="effective_from"
                  className="w-full px-3 py-2.5 rounded-lg border border-ppp-charcoal-200 text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[44px]"
                />
                <span className="block mt-1 text-[11px] text-ppp-charcoal-500">
                  Leave blank for &ldquo;always.&rdquo;
                </span>
              </label>
              <label className="block sm:col-span-2">
                <span className="block text-[11.5px] font-semibold text-ppp-charcoal-700 mb-1">
                  Notes
                </span>
                <input
                  type="text"
                  name="notes"
                  maxLength={500}
                  placeholder="Contract ref, memo…"
                  className="w-full px-3 py-2.5 rounded-lg border border-ppp-charcoal-200 text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[44px]"
                />
              </label>
            </div>
            <div className="flex justify-end">
              <PendingSubmitButton
                className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 disabled:opacity-60 disabled:cursor-not-allowed min-h-[40px]"
                pendingLabel="Saving…"
              >
                Save override
              </PendingSubmitButton>
            </div>
          </form>
        )}
      </section>

      {/* Archive */}
      {isAdmin && product.is_active && (
        <section className="bg-white border border-rose-100 rounded-xl p-4 sm:p-6">
          <h2 className="text-sm font-semibold text-ppp-charcoal mb-2">
            Archive
          </h2>
          <p className="text-[12px] text-ppp-charcoal-500 mb-3">
            Hides the SKU from the picker. Historical invoices are untouched.
            The SKU frees up so a replacement can reuse it.
          </p>
          <form action={archiveAction}>
            <input type="hidden" name="id" value={product.id} />
            <PendingSubmitButton
              className="inline-flex items-center px-4 py-2 rounded-md border border-rose-200 text-rose-800 text-xs font-semibold hover:bg-rose-50 min-h-[40px]"
              pendingLabel="Archiving…"
            >
              Archive product
            </PendingSubmitButton>
          </form>
        </section>
      )}
    </div>
  );
}
