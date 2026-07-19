import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { listProducts, type CommercialProduct } from "@/lib/commercial/products/db";
import {
  PRODUCT_CATEGORIES,
  PRODUCT_SURFACE_AREAS,
  productCategoryLabel,
  productSurfaceAreaLabel,
  productUnitLabel,
} from "@/lib/commercial/products/constants";
import { SELECT_CLS, SELECT_BG_STYLE } from "@/lib/commercial/form-classnames";

/**
 * Product Library — Phase D catalog + F.6 variations.
 *
 * Grouped view: top-level products are rendered by surface_area (Interior /
 * Exterior / Both / Other). Each product with variations shows the
 * variations indented underneath in a lightweight sub-list (variation
 * label + SKU + price). Standalone products render as normal rows.
 *
 * Search + category + surface_area filter above. Read-open, admin-write.
 */

export const dynamic = "force-dynamic";

function formatDollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const SURFACE_ORDER: readonly string[] = [
  "interior",
  "exterior",
  "both",
  "other",
];

export default async function ProductsCatalogPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    category?: string;
    surface?: string;
    archived?: string;
    ok?: string;
    error?: string;
  }>;
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

  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const category = sp.category ?? "";
  const surface = sp.surface ?? "";
  const includeInactive = sp.archived === "1";

  // Fetch the FULL universe when a text search is active so we can also
  // surface a parent whose variations match the term (even if the parent
  // itself doesn't match). Then filter client-side to keep the grouped
  // hierarchy intact.
  const rawProducts = await listProducts({
    q: q || undefined,
    category: category || undefined,
    surface_area: surface || undefined,
    includeInactive,
  });
  // Build parent lookup — always fetch the parents of any matched
  // variations so the tree renders correctly even when the parent
  // itself was filtered out.
  const productById = new Map(rawProducts.map((p) => [p.id, p] as const));
  const missingParentIds = new Set<string>();
  for (const p of rawProducts) {
    if (p.parent_product_id && !productById.has(p.parent_product_id)) {
      missingParentIds.add(p.parent_product_id);
    }
  }
  let allProducts = rawProducts;
  if (missingParentIds.size > 0) {
    const extra = await listProducts({ includeInactive: true });
    const extras = extra.filter((p) => missingParentIds.has(p.id));
    allProducts = [...rawProducts, ...extras];
  }

  const activeCount = rawProducts.filter((p) => p.is_active).length;
  const archivedCount = rawProducts.length - activeCount;

  // Group: top-level products (no parent) bucketed by surface_area.
  // Variations sit under their parent regardless of surface_area (they
  // inherit parent's grouping visually).
  const variationsByParent = new Map<string, CommercialProduct[]>();
  for (const p of allProducts) {
    if (p.parent_product_id) {
      const arr = variationsByParent.get(p.parent_product_id) ?? [];
      arr.push(p);
      variationsByParent.set(p.parent_product_id, arr);
    }
  }
  const parents = allProducts
    .filter((p) => !p.parent_product_id)
    .sort((a, b) => a.name.localeCompare(b.name));

  const bySurface = new Map<string, CommercialProduct[]>();
  for (const s of SURFACE_ORDER) bySurface.set(s, []);
  for (const p of parents) {
    const bucket = bySurface.get(p.surface_area) ?? bySurface.get("other")!;
    bucket.push(p);
  }

  return (
    <div className="space-y-5">
      <header>
        <span aria-hidden className="block h-[3px] w-10 rounded-full mb-3 bg-cc-brand-600" />
        <div className="flex flex-wrap items-baseline justify-between gap-3 mb-2">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ppp-charcoal">
              Product Library
            </h1>
            <span className="inline-flex items-center text-[10px] font-bold tracking-widest uppercase text-cc-brand-700 bg-cc-brand-50 border border-cc-brand-200 px-2 py-0.5 rounded">
              {activeCount} active
            </span>
            {includeInactive && archivedCount > 0 && (
              <span className="inline-flex items-center text-[10px] font-bold tracking-widest uppercase text-ppp-charcoal-500 bg-ppp-charcoal-50 border border-ppp-charcoal-100 px-2 py-0.5 rounded">
                {archivedCount} archived
              </span>
            )}
          </div>
          {isAdmin && (
            <Link
              href="/commercial/pre-job/products/new"
              className="inline-flex items-center justify-center px-4 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px]"
            >
              New product
            </Link>
          )}
        </div>
        <p className="text-sm text-ppp-charcoal-500">
          Grouped by surface area, with variations nested under their parent
          product. Line items on proposals + invoices auto-fill from here.
        </p>
      </header>

      {sp.ok && (
        <div className="bg-cc-brand-50 border border-cc-brand-200 rounded-xl px-4 py-2.5 text-sm text-cc-brand-800">
          {sp.ok === "created" && "Product created."}
          {sp.ok === "updated" && "Product updated."}
          {sp.ok === "archived" && "Product archived."}
        </div>
      )}
      {sp.error && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-2.5 text-sm text-rose-800">
          {decodeURIComponent(sp.error)}
        </div>
      )}

      {/* Search + filter row */}
      <form
        method="GET"
        className="bg-white border border-ppp-charcoal-100 rounded-xl p-3 sm:p-4 flex flex-col sm:flex-row gap-2 flex-wrap"
      >
        <label className="flex-1 min-w-[180px]">
          <span className="sr-only">Search products</span>
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Search SKU, name, or variation…"
            className="w-full px-3 py-2.5 rounded-lg border border-ppp-charcoal-200 text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[44px]"
          />
        </label>
        <label className="sm:w-40">
          <span className="sr-only">Surface area</span>
          <select
            name="surface"
            defaultValue={surface}
            className={SELECT_CLS}
            style={SELECT_BG_STYLE}
          >
            <option value="">All surfaces</option>
            {PRODUCT_SURFACE_AREAS.map((s) => (
              <option key={s} value={s}>
                {productSurfaceAreaLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <label className="sm:w-40">
          <span className="sr-only">Category</span>
          <select
            name="category"
            defaultValue={category}
            className={SELECT_CLS}
            style={SELECT_BG_STYLE}
          >
            <option value="">All categories</option>
            {PRODUCT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {productCategoryLabel(c)}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-flex items-center gap-2 text-[13px] text-ppp-charcoal-700 px-2 sm:px-0 min-h-[44px]">
          <input
            type="checkbox"
            name="archived"
            value="1"
            defaultChecked={includeInactive}
            className="h-4 w-4 rounded border-ppp-charcoal-300 text-cc-brand-600 focus:ring-cc-brand-500"
          />
          Show archived
        </label>
        <button
          type="submit"
          className="inline-flex items-center justify-center px-4 py-2.5 rounded-lg border border-ppp-charcoal-200 text-sm font-medium text-ppp-charcoal hover:bg-ppp-charcoal-50 min-h-[44px]"
        >
          Apply
        </button>
      </form>

      {/* List — grouped by surface_area, variations nested under parents. */}
      {parents.length === 0 ? (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-8 text-center">
          <p className="text-sm text-ppp-charcoal-500 mb-2">
            {q || category || surface
              ? "No products match those filters."
              : "No products in the catalog yet."}
          </p>
          {isAdmin && !q && !category && !surface && (
            <Link
              href="/commercial/pre-job/products/new"
              className="inline-flex items-center justify-center px-4 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px]"
            >
              Add the first one
            </Link>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          {SURFACE_ORDER.map((surfaceKey) => {
            const rows = bySurface.get(surfaceKey) ?? [];
            if (rows.length === 0) return null;
            return (
              <section key={surfaceKey}>
                <h2 className="text-[11px] font-bold uppercase tracking-widest text-ppp-charcoal-500 mb-2 flex items-center gap-2">
                  <span
                    aria-hidden
                    className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-500"
                  />
                  {productSurfaceAreaLabel(surfaceKey)}
                  <span className="text-ppp-charcoal-400 font-medium normal-case tracking-normal">
                    · {rows.length}
                  </span>
                </h2>
                <ul className="space-y-2">
                  {rows.map((p) => {
                    const variations = variationsByParent.get(p.id) ?? [];
                    const hasVariations = variations.length > 0;
                    return (
                      <li
                        key={p.id}
                        className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden"
                      >
                        <Link
                          href={`/commercial/pre-job/products/${p.id}`}
                          className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 group p-3 sm:p-4 hover:bg-ppp-charcoal-50/40"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-baseline gap-2 flex-wrap">
                              <span className="font-semibold text-[14px] text-ppp-charcoal group-hover:text-cc-brand-700 truncate">
                                {p.name}
                              </span>
                              {!hasVariations && (
                                <span className="inline-flex items-center text-[10px] font-bold tracking-widest uppercase text-ppp-charcoal-500 bg-ppp-charcoal-50 border border-ppp-charcoal-100 px-1.5 py-0.5 rounded font-mono">
                                  {p.sku}
                                </span>
                              )}
                              {hasVariations && (
                                <span className="inline-flex items-center text-[10px] font-bold tracking-widest uppercase text-cc-brand-700 bg-cc-brand-50 border border-cc-brand-200 px-1.5 py-0.5 rounded">
                                  {variations.length}{" "}
                                  variation{variations.length === 1 ? "" : "s"}
                                </span>
                              )}
                              {!p.is_active && (
                                <span className="inline-flex items-center text-[10px] font-bold tracking-widest uppercase text-amber-800 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
                                  archived
                                </span>
                              )}
                            </div>
                            <div className="text-[12px] text-ppp-charcoal-500 mt-0.5 flex items-center gap-x-2 flex-wrap">
                              <span>{productCategoryLabel(p.category)}</span>
                              <span aria-hidden className="text-ppp-charcoal-300">·</span>
                              <span>per {productUnitLabel(p.unit)}</span>
                              {p.description && (
                                <>
                                  <span aria-hidden className="text-ppp-charcoal-300">·</span>
                                  <span className="truncate">{p.description}</span>
                                </>
                              )}
                            </div>
                          </div>
                          {!hasVariations && (
                            <div className="flex sm:flex-col items-baseline sm:items-end gap-x-3 sm:gap-x-0 shrink-0">
                              <div className="text-[15px] font-bold tabular-nums text-ppp-charcoal">
                                {formatDollars(p.default_unit_price_cents)}
                              </div>
                              {p.default_unit_cost_cents !== null && (
                                <div
                                  className="text-[11px] text-ppp-charcoal-500 tabular-nums"
                                  title="PPP unit cost"
                                >
                                  cost {formatDollars(p.default_unit_cost_cents)}
                                </div>
                              )}
                            </div>
                          )}
                        </Link>
                        {hasVariations && (
                          <ul className="border-t border-ppp-charcoal-100 bg-ppp-charcoal-50/30 divide-y divide-ppp-charcoal-100">
                            {variations
                              .slice()
                              .sort((a, b) =>
                                (a.variation_label ?? "").localeCompare(
                                  b.variation_label ?? ""
                                )
                              )
                              .map((v) => (
                                <li key={v.id}>
                                  <Link
                                    href={`/commercial/pre-job/products/${v.id}`}
                                    className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 group px-4 sm:px-6 py-2.5 hover:bg-cc-brand-50/40"
                                  >
                                    <div className="flex-1 min-w-0 flex items-baseline gap-2 flex-wrap">
                                      <span aria-hidden className="text-cc-brand-400">
                                        ↳
                                      </span>
                                      <span className="text-[13px] font-medium text-ppp-charcoal group-hover:text-cc-brand-700 truncate">
                                        {v.variation_label ?? v.name}
                                      </span>
                                      <span className="inline-flex items-center text-[10px] font-bold tracking-widest uppercase text-ppp-charcoal-500 bg-white border border-ppp-charcoal-100 px-1.5 py-0.5 rounded font-mono">
                                        {v.sku}
                                      </span>
                                      {!v.is_active && (
                                        <span className="inline-flex items-center text-[10px] font-bold tracking-widest uppercase text-amber-800 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
                                          archived
                                        </span>
                                      )}
                                    </div>
                                    <div className="text-[13px] font-bold tabular-nums text-ppp-charcoal shrink-0">
                                      {formatDollars(v.default_unit_price_cents)}
                                    </div>
                                  </Link>
                                </li>
                              ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      {!isAdmin && (
        <p className="text-[11.5px] text-ppp-charcoal-400 pt-2">
          You can browse the catalog. Only admins can add, edit, or
          archive products.
        </p>
      )}
    </div>
  );
}
