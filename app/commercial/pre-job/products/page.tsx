import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { listProducts } from "@/lib/commercial/products/db";
import {
  PRODUCT_CATEGORIES,
  productCategoryLabel,
  productUnitLabel,
} from "@/lib/commercial/products/constants";
import { SELECT_CLS, SELECT_BG_STYLE } from "@/lib/commercial/form-classnames";

/**
 * Product Library — Phase D catalog. Alex + Katie curate the SKU list
 * (paint, sundries, labor) that later powers ProductPicker on invoice
 * line items + future proposal builder. Reads open to any commercial
 * user; writes gated to admins to keep Tomco-style negotiated pricing
 * from drifting.
 *
 * Search: SKU + name ilike. Filter: category + archived toggle.
 */

export const dynamic = "force-dynamic";

function formatDollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default async function ProductsCatalogPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    category?: string;
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
  const includeInactive = sp.archived === "1";

  const products = await listProducts({
    q: q || undefined,
    category: category || undefined,
    includeInactive,
  });
  const activeCount = products.filter((p) => p.is_active).length;
  const archivedCount = products.length - activeCount;

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
          SKU catalog for paint, sundries, labor. Products picked here
          auto-fill invoice line items with description + unit + price.
          Tomco-style negotiated rates live on each product&apos;s detail
          page.
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
        className="bg-white border border-ppp-charcoal-100 rounded-xl p-3 sm:p-4 flex flex-col sm:flex-row gap-2"
      >
        <label className="flex-1 min-w-0">
          <span className="sr-only">Search products</span>
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Search SKU or name…"
            className="w-full px-3 py-2.5 rounded-lg border border-ppp-charcoal-200 text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[44px]"
          />
        </label>
        <label className="sm:w-44">
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

      {/* List */}
      {products.length === 0 ? (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-8 text-center">
          <p className="text-sm text-ppp-charcoal-500 mb-2">
            {q || category
              ? "No products match those filters."
              : "No products in the catalog yet."}
          </p>
          {isAdmin && !q && !category && (
            <Link
              href="/commercial/pre-job/products/new"
              className="inline-flex items-center justify-center px-4 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px]"
            >
              Add the first one
            </Link>
          )}
        </div>
      ) : (
        <ul className="space-y-2">
          {products.map((p) => (
            <li
              key={p.id}
              className="bg-white border border-ppp-charcoal-100 rounded-xl p-3 sm:p-4"
            >
              <Link
                href={`/commercial/pre-job/products/${p.id}`}
                className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 group"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="font-semibold text-[14px] text-ppp-charcoal group-hover:text-cc-brand-700 truncate">
                      {p.name}
                    </span>
                    <span className="inline-flex items-center text-[10px] font-bold tracking-widest uppercase text-ppp-charcoal-500 bg-ppp-charcoal-50 border border-ppp-charcoal-100 px-1.5 py-0.5 rounded font-mono">
                      {p.sku}
                    </span>
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
                    {p.notes && (
                      <>
                        <span aria-hidden className="text-ppp-charcoal-300">·</span>
                        <span className="truncate">{p.notes}</span>
                      </>
                    )}
                  </div>
                </div>
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
              </Link>
            </li>
          ))}
        </ul>
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
