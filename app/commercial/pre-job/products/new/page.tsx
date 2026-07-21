import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { createProduct, listProducts } from "@/lib/commercial/products/db";
import {
  PRODUCT_CATEGORIES,
  PRODUCT_SURFACE_AREAS,
  PRODUCT_UNITS,
  productCategoryLabel,
  productSurfaceAreaLabel,
  productUnitLabel,
} from "@/lib/commercial/products/constants";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import { SearchableSelect } from "@/components/commercial/searchable-select";
import { SELECT_CLS, SELECT_BG_STYLE } from "@/lib/commercial/form-classnames";

/**
 * Create-product form. Admin-only (matches archive/edit gate on the
 * list page). Redirects back to the catalog with ?ok=created on
 * success, or back to this form with ?error=... on failure so the
 * user can fix without losing typed input.
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

async function createAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(user.email);
  if (!isAdmin) redirect("/commercial/pre-job/products");

  const sku = String(formData.get("sku") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const category = String(formData.get("category") ?? "other");
  const unit = String(formData.get("unit") ?? "each");
  const price = parseDollarsToCents(formData.get("default_unit_price"));
  const cost = parseDollarsToCents(formData.get("default_unit_cost"));
  const notes = String(formData.get("notes") ?? "").trim() || null;
  // F.6: variation + surface_area + description.
  const parentRaw = String(formData.get("parent_product_id") ?? "").trim();
  const parent_product_id = parentRaw || null;
  const variation_label =
    String(formData.get("variation_label") ?? "").trim() || null;
  const surface_area = String(formData.get("surface_area") ?? "other");
  const description = String(formData.get("description") ?? "").trim() || null;

  if (!sku)
    redirect(
      "/commercial/pre-job/products/new?error=" +
        encodeURIComponent("SKU is required.")
    );
  if (!name)
    redirect(
      "/commercial/pre-job/products/new?error=" +
        encodeURIComponent("Name is required.")
    );
  if (price === null)
    redirect(
      "/commercial/pre-job/products/new?error=" +
        encodeURIComponent("Default price must be a positive dollar amount.")
    );

  const result = await createProduct({
    sku,
    name,
    category,
    unit,
    default_unit_price_cents: price,
    default_unit_cost_cents: cost,
    notes,
    parent_product_id,
    variation_label,
    surface_area,
    description,
    created_by_user_id: user.id,
  });
  if (!result.ok) {
    redirect(
      "/commercial/pre-job/products/new?error=" +
        encodeURIComponent(result.error)
    );
  }
  // Bust the catalog cache on every surface that reads listProducts()
  // so the ProductPicker on the invoice list sees the new SKU without
  // a hard refresh.
  revalidatePath("/commercial/pre-job/products");
  revalidatePath("/commercial/invoices");
  revalidatePath("/commercial");
  redirect(
    "/commercial/pre-job/products/" + result.product.id + "?ok=created"
  );
}

export default async function NewProductPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
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
  if (!isAdmin) redirect("/commercial/pre-job/products");

  const sp = await searchParams;
  // F.6: fetch top-level products (no parent) for the "Variation of…"
  // picker. Only top-level products can be parents (enforced server-side
  // too — no nested variations).
  const allProducts = await listProducts({ includeInactive: false });
  const parentCandidates = allProducts
    .filter((p) => !p.parent_product_id)
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="max-w-2xl space-y-5">
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
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ppp-charcoal">
          New product
        </h1>
        <p className="text-sm text-ppp-charcoal-500 mt-1">
          Add a paint SKU, sundry, or labor item. Line items across the
          platform can then auto-fill from this row.
        </p>
      </header>

      {sp.error && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-2.5 text-sm text-rose-800">
          {decodeURIComponent(sp.error)}
        </div>
      )}

      <form
        action={createAction}
        className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 sm:p-6 space-y-4"
      >
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
              placeholder="BM-AURA-INT-SG"
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
              placeholder="Benjamin Moore Aura Interior Semi-Gloss"
              className="w-full px-3 py-2.5 rounded-lg border border-ppp-charcoal-200 text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[44px]"
            />
          </label>
          <label className="block">
            <span className="block text-[12px] font-semibold text-ppp-charcoal-700 mb-1">
              Category
            </span>
            <select
              name="category"
              defaultValue="paint"
              className={SELECT_CLS}
              style={SELECT_BG_STYLE}
            >
              {PRODUCT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {productCategoryLabel(c)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-[12px] font-semibold text-ppp-charcoal-700 mb-1">
              Unit
            </span>
            <select
              name="unit"
              defaultValue="gallon"
              className={SELECT_CLS}
              style={SELECT_BG_STYLE}
            >
              {PRODUCT_UNITS.map((u) => (
                <option key={u} value={u}>
                  {productUnitLabel(u)}
                </option>
              ))}
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
              placeholder="79.99"
              className="w-full px-3 py-2.5 rounded-lg border border-ppp-charcoal-200 text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[44px] tabular-nums"
            />
            <span className="block mt-1 text-[11px] text-ppp-charcoal-500">
              Retail per unit — what shows on invoices by default.
            </span>
          </label>
          <label className="block">
            <span className="block text-[12px] font-semibold text-ppp-charcoal-700 mb-1">
              PPP cost ($)
            </span>
            <input
              type="text"
              name="default_unit_cost"
              inputMode="decimal"
              placeholder="52.40"
              className="w-full px-3 py-2.5 rounded-lg border border-ppp-charcoal-200 text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[44px] tabular-nums"
            />
            <span className="block mt-1 text-[11px] text-ppp-charcoal-500">
              What PPP pays. Used for margin math on line items.
            </span>
          </label>
        </div>
        {/* F.6: Interior/Exterior facet + parent/variation grouping. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block">
            <span className="block text-[12px] font-semibold text-ppp-charcoal-700 mb-1">
              Surface area
            </span>
            <select
              name="surface_area"
              defaultValue="other"
              className={SELECT_CLS}
              style={SELECT_BG_STYLE}
            >
              {PRODUCT_SURFACE_AREAS.map((s) => (
                <option key={s} value={s}>
                  {productSurfaceAreaLabel(s)}
                </option>
              ))}
            </select>
            <span className="block mt-1 text-[11px] text-ppp-charcoal-500">
              Interior / Exterior grouping in the catalog browser.
            </span>
          </label>
          <label className="block">
            <span className="block text-[12px] font-semibold text-ppp-charcoal-700 mb-1">
              Variation of…
            </span>
            {/* Karan 2026-07-21 (searchable-dropdown rule): was a plain
                <select> listing every product (~40+ after the Tomco seed).
                Now type-to-filter. Empty selection = standalone product. */}
            <SearchableSelect
              name="parent_product_id"
              options={parentCandidates.map((p) => ({ value: p.id, label: p.name }))}
              placeholder="Standalone — type to pick a parent…"
              ariaLabel="Variation of parent product"
            />
            <span className="block mt-1 text-[11px] text-ppp-charcoal-500">
              Leave blank for a standalone product, or pick a parent to make
              this a variation (e.g. Seal &amp; Poly).
            </span>
          </label>
        </div>
        <label className="block">
          <span className="block text-[12px] font-semibold text-ppp-charcoal-700 mb-1">
            Variation label
          </span>
          <input
            type="text"
            name="variation_label"
            maxLength={80}
            placeholder="Seal & Poly"
            className="w-full px-3 py-2.5 rounded-lg border border-ppp-charcoal-200 text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[44px]"
          />
          <span className="block mt-1 text-[11px] text-ppp-charcoal-500">
            Required when a parent is picked. Shows as "{'{parent name}'} ({'{label}'})" in the picker.
          </span>
        </label>
        <label className="block">
          <span className="block text-[12px] font-semibold text-ppp-charcoal-700 mb-1">
            Description
          </span>
          <textarea
            name="description"
            maxLength={2000}
            rows={2}
            placeholder="Frame paint + wood door clear finish."
            className="w-full px-3 py-2.5 rounded-lg border border-ppp-charcoal-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 resize-y"
          />
          <span className="block mt-1 text-[11px] text-ppp-charcoal-500">
            Shown under the line item on the customer proposal PDF.
          </span>
        </label>
        <label className="block">
          <span className="block text-[12px] font-semibold text-ppp-charcoal-700 mb-1">
            Internal notes
          </span>
          <textarea
            name="notes"
            maxLength={2000}
            rows={2}
            placeholder="Internal reference — spec, min-order, retailer contact."
            className="w-full px-3 py-2.5 rounded-lg border border-ppp-charcoal-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 resize-y"
          />
          <span className="block mt-1 text-[11px] text-ppp-charcoal-500">
            Never shown to customers. Team-only reference.
          </span>
        </label>
        <div className="flex flex-col sm:flex-row-reverse gap-2 pt-2 border-t border-ppp-charcoal-100">
          <PendingSubmitButton
            className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 disabled:opacity-60 disabled:cursor-not-allowed min-h-[44px]"
            pendingLabel="Creating…"
          >
            Create product
          </PendingSubmitButton>
          <Link
            href="/commercial/pre-job/products"
            className="inline-flex items-center justify-center px-4 py-2.5 rounded-lg border border-ppp-charcoal-200 text-sm font-medium text-ppp-charcoal hover:bg-ppp-charcoal-50 min-h-[44px]"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
