"use client";

/**
 * ProductPicker — searchable dropdown over the active product catalog.
 * Sits inside the invoice line-item form. When the user picks a row:
 *
 *   1. Sets hidden `product_id` input.
 *   2. Fetches /api/commercial/products/resolve with the account_id so
 *      the picked price reflects any Tomco-style override.
 *   3. Auto-fills description / unit / unit_price on the form's regular
 *      fields (user can still edit before submit).
 *
 * The picker doesn't remove the manual description/quantity/price
 * fields — that keeps free-text line items possible for one-off
 * work not in the catalog. Picking "Free-text" (the first row) clears
 * product_id so the row stays a legacy free-text entry.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { productUnitLabel } from "@/lib/commercial/products/constants";

export type PickableProduct = {
  id: string;
  sku: string;
  name: string;
  category: string;
  unit: string;
  default_unit_price_cents: number;
  // F.6: variation grouping + description flow.
  variation_label?: string | null;
  description?: string | null;
  /** F.6: parent-only products (rows with children in the catalog)
   *  render as browse-only headers — picking them shows a helper hint
   *  to pick a variation instead, and blocks the pick. */
  is_parent_only?: boolean;
  /** F.6: when this row IS a variation, the parent product's id.
   *  Used to filter the picker into "variations-of-this-parent" mode
   *  when the user clicks a parent header row. */
  parent_product_id?: string | null;
};

function centsToDollarStr(cents: number): string {
  return (cents / 100).toFixed(2);
}

function formatDollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

type Props = {
  products: PickableProduct[];
  /** For customer-override resolution. May be null when the invoice
   *  isn't associated with an account. */
  accountId: string | null;
  /** DOM ids of the form inputs the picker auto-fills. */
  descriptionInputId: string;
  unitInputId: string;
  unitPriceInputId: string;
  /** DOM id of the hidden product_id input this picker owns. */
  productIdInputId: string;
};

export default function ProductPicker({
  products,
  accountId,
  descriptionInputId,
  unitInputId,
  unitPriceInputId,
  productIdInputId,
}: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [picked, setPicked] = useState<PickableProduct | null>(null);
  const [priceNote, setPriceNote] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  // F.6 audit fix (2026-07-19): when the user clicks a parent-only
  // "PICK A VARIATION" row, drop the picker into a filtered "show only
  // variations of X" mode until they either pick a variation or clear
  // it. Fixes the dead-end Karan hit where clicking the parent did
  // nothing visible even though variations were listed below it.
  const [parentFilter, setParentFilter] = useState<PickableProduct | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const results = useMemo(() => {
    // F.6 audit fix: parent-filter mode wins over free-text search.
    // Show every ACTIVE variation of the selected parent, sorted by
    // variation label so "Per Linear Yard" reliably appears above
    // "Per Square Foot" (matches Product Library display).
    if (parentFilter) {
      return products
        .filter((p) => p.parent_product_id === parentFilter.id)
        .sort((a, b) =>
          (a.variation_label ?? "").localeCompare(b.variation_label ?? "")
        );
    }
    const q = query.trim().toLowerCase();
    if (!q) return products.slice(0, 25);
    // Prefix match first (SKU + name), then substring — mirrors the
    // Karan-approved SearchableSelect behavior across the platform.
    // F.6: also match variation_label so typing "Seal & Poly" finds
    // the variation directly.
    const prefixSku: PickableProduct[] = [];
    const prefixName: PickableProduct[] = [];
    const substring: PickableProduct[] = [];
    for (const p of products) {
      const sku = p.sku.toLowerCase();
      const name = p.name.toLowerCase();
      const variation = (p.variation_label ?? "").toLowerCase();
      if (sku.startsWith(q)) prefixSku.push(p);
      else if (name.startsWith(q)) prefixName.push(p);
      else if (
        sku.includes(q) ||
        name.includes(q) ||
        variation.includes(q)
      ) {
        substring.push(p);
      }
    }
    return [...prefixSku, ...prefixName, ...substring].slice(0, 25);
  }, [products, query, parentFilter]);

  useEffect(() => {
    if (!open) return;
    setHighlight(0);
  }, [open, query]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Scroll the highlighted row into view.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLLIElement>(
      `[data-idx="${highlight}"]`
    );
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  function setFormValue(id: string, value: string) {
    const el = document.getElementById(id) as
      | HTMLInputElement
      | HTMLTextAreaElement
      | null;
    if (!el) return;
    el.value = value;
    // Fire input + change so any listeners (validation, dirty state)
    // react to the programmatic change.
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function pick(p: PickableProduct) {
    // F.6 audit fix (2026-07-19): clicking a parent header now drops
    // the picker into "variations-of-X" mode instead of silently
    // no-op'ing. Karan's bug: clicking the parent row did nothing
    // visible even though variations were already listed below.
    // Now the list re-filters to just this parent's variations and a
    // banner appears at the top with a "← back to all" affordance.
    if (p.is_parent_only) {
      setParentFilter(p);
      setHighlight(0);
      setOpen(true);
      // Focus the search input so keyboard nav works immediately +
      // typing anything cancels the filter (see input onChange).
      inputRef.current?.focus();
      return;
    }
    // Any real pick clears any active parent filter.
    setParentFilter(null);
    setPicked(p);
    // F.6: display combines parent name + variation label so the picker
    // input shows "HM Frame & Wood Door (Seal & Poly)" after pick.
    const displayName = p.variation_label
      ? `${p.name} (${p.variation_label})`
      : p.name;
    setQuery(displayName);
    setOpen(false);
    setFormValue(productIdInputId, p.id);
    // Instant defaults so the row is usable even before the price
    // resolve API returns. Description prefill:
    //   - Standalone: use description (fallback: name)
    //   - Variation:  "{parent name} — {variation label}: {description}"
    const descriptionSeed = p.variation_label
      ? `${displayName}${p.description ? ": " + p.description : ""}`
      : p.description || p.name;
    setFormValue(descriptionInputId, descriptionSeed);
    // Audit fix (2026-07-19): write the FRIENDLY unit label ("linear ft"
    // not raw enum "linear_foot") so the tiny unit input doesn't
    // truncate to "linea…" and the customer sees a real unit on the PDF.
    // Line items store free-text unit; the friendly label round-trips
    // cleanly through save + reload + PDF render.
    setFormValue(unitInputId, productUnitLabel(p.unit));
    setFormValue(unitPriceInputId, centsToDollarStr(p.default_unit_price_cents));
    setPriceNote(
      `catalog default · ${formatDollars(p.default_unit_price_cents)}`
    );

    // Cancel any pending resolve.
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    setResolving(true);
    try {
      const url = new URL(
        "/api/commercial/products/resolve",
        window.location.origin
      );
      url.searchParams.set("product_id", p.id);
      if (accountId) url.searchParams.set("account_id", accountId);
      const res = await fetch(url.toString(), {
        signal: ctl.signal,
        cache: "no-store",
      });
      if (!res.ok) return;
      const data: {
        ok: boolean;
        unit_price_cents?: number;
        applied?: string;
        source?: string;
      } = await res.json();
      if (data.ok && typeof data.unit_price_cents === "number") {
        setFormValue(unitPriceInputId, centsToDollarStr(data.unit_price_cents));
        setPriceNote(
          `${data.applied ?? "catalog default"} · ${formatDollars(data.unit_price_cents)}`
        );
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        // Silent — fields already have catalog defaults.
      }
    } finally {
      if (abortRef.current === ctl) setResolving(false);
    }
  }

  function clearPick() {
    setPicked(null);
    setQuery("");
    setPriceNote(null);
    setParentFilter(null);
    setFormValue(productIdInputId, "");
    // Deliberately DON'T clear description/unit/unit_price — the user
    // might want to keep them as-is with a manual tweak.
  }

  return (
    <div ref={rootRef} className="relative">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <label className="flex-1 block">
          <span className="block text-[11px] font-semibold text-ppp-charcoal-700 mb-1">
            Product (optional)
          </span>
          <div className="relative">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOpen(true);
                // Typing cancels the "variations-of-X" filter — back to
                // global search. Prevents Alex being stuck in a filtered
                // view he can't escape without hitting the ×.
                if (parentFilter) setParentFilter(null);
                if (picked && e.target.value !== picked.name) {
                  setPicked(null);
                  setFormValue(productIdInputId, "");
                }
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setOpen(true);
                  setHighlight((h) => Math.min(h + 1, results.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setHighlight((h) => Math.max(h - 1, 0));
                } else if (e.key === "Enter") {
                  if (open && results[highlight]) {
                    e.preventDefault();
                    pick(results[highlight]);
                  }
                } else if (e.key === "Escape") {
                  setOpen(false);
                }
              }}
              placeholder="Search SKU or name…"
              autoComplete="off"
              role="combobox"
              aria-expanded={open}
              aria-autocomplete="list"
              aria-controls="product-picker-listbox"
              aria-activedescendant={
                open ? `product-picker-option-${highlight}` : undefined
              }
              className="w-full px-3 py-2.5 rounded-lg border border-ppp-charcoal-200 text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[44px]"
            />
            {(picked || query) && (
              <button
                type="button"
                onClick={clearPick}
                aria-label="Clear picked product"
                className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 inline-flex items-center justify-center rounded-md text-ppp-charcoal-400 hover:text-ppp-charcoal hover:bg-ppp-charcoal-50 focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M6 6l12 12 M18 6l-12 12" />
                </svg>
              </button>
            )}
          </div>
        </label>
        {priceNote && (
          <div className="text-[11px] text-ppp-charcoal-500 sm:min-w-[130px] tabular-nums">
            {resolving ? "Resolving price…" : priceNote}
          </div>
        )}
      </div>

      {/* F.6 audit fix: parent-filter mode empty state — if the parent
          has no active variations, tell the user instead of showing an
          empty dropdown. */}
      {open && parentFilter && results.length === 0 && (
        <div className="absolute z-50 left-0 right-0 mt-1 rounded-lg border border-ppp-charcoal-200 bg-white shadow-lg overflow-hidden">
          <div className="flex items-center justify-between gap-2 px-3 py-2 bg-cc-brand-50 border-b border-cc-brand-100">
            <span className="text-[12px] font-semibold text-cc-brand-800 truncate">
              Choose a variation of {parentFilter.name}
            </span>
            <button
              type="button"
              onClick={() => setParentFilter(null)}
              className="text-[11px] font-medium text-cc-brand-700 hover:text-cc-brand-900 shrink-0"
            >
              ← Back to all
            </button>
          </div>
          <div className="px-3 py-4 text-[12.5px] text-ppp-charcoal-600 text-center">
            No active variations yet under this product.
          </div>
        </div>
      )}

      {open && results.length > 0 && (
        <div className="absolute z-50 left-0 right-0 mt-1 rounded-lg border border-ppp-charcoal-200 bg-white shadow-lg overflow-hidden">
          {/* F.6 audit fix: banner header when the user is filtered to a
              parent's variations. Gives them an unambiguous way to see
              what they're picking from + get back. */}
          {parentFilter && (
            <div className="flex items-center justify-between gap-2 px-3 py-2 bg-cc-brand-50 border-b border-cc-brand-100">
              <span className="text-[12px] font-semibold text-cc-brand-800 truncate">
                Choose a variation of {parentFilter.name}
              </span>
              <button
                type="button"
                onClick={() => setParentFilter(null)}
                className="text-[11px] font-medium text-cc-brand-700 hover:text-cc-brand-900 shrink-0"
              >
                ← Back to all
              </button>
            </div>
          )}
          <ul
            ref={listRef}
            id="product-picker-listbox"
            role="listbox"
            className="max-h-72 overflow-y-auto"
          >
          {results.map((p, idx) => (
            <li
              key={p.id}
              id={`product-picker-option-${idx}`}
              data-idx={idx}
              role="option"
              aria-selected={idx === highlight}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(p);
              }}
              onMouseEnter={() => setHighlight(idx)}
              className={`px-3 py-2 cursor-pointer border-b border-ppp-charcoal-100 last:border-b-0 ${
                idx === highlight
                  ? "bg-cc-brand-50"
                  : "hover:bg-ppp-charcoal-50"
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold text-ppp-charcoal truncate flex items-center gap-1.5">
                    <span className="truncate">
                      {p.name}
                      {p.variation_label && (
                        <span className="text-cc-brand-700 font-normal">
                          {" "}({p.variation_label})
                        </span>
                      )}
                    </span>
                    {p.is_parent_only && (
                      <span className="inline-flex items-center text-[9px] font-bold tracking-widest uppercase text-ppp-charcoal-500 bg-ppp-charcoal-100 px-1.5 py-0.5 rounded shrink-0">
                        pick a variation
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-ppp-charcoal-500 flex items-center gap-x-2">
                    <span className="font-mono">{p.sku}</span>
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
                {!p.is_parent_only && (
                  <div className="text-[12.5px] font-bold tabular-nums text-ppp-charcoal shrink-0">
                    {formatDollars(p.default_unit_price_cents)}
                  </div>
                )}
              </div>
            </li>
          ))}
          </ul>
        </div>
      )}

      {open && !parentFilter && query.trim() && results.length === 0 && (
        <div className="absolute z-50 left-0 right-0 mt-1 rounded-lg border border-ppp-charcoal-200 bg-white shadow-lg p-3 space-y-2">
          <div className="text-[12.5px] text-ppp-charcoal-600">
            No products match <span className="font-semibold text-ppp-charcoal">&ldquo;{query}&rdquo;</span>. Keep typing the row as free text below, or add it to the catalog:
          </div>
          <a
            href="/commercial/pre-job/products/new"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-cc-brand-50 border border-cc-brand-200 text-cc-brand-800 text-[12.5px] font-semibold hover:bg-cc-brand-100 focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[36px]"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 5v14 M5 12h14" />
            </svg>
            Add to Product Library
          </a>
        </div>
      )}
    </div>
  );
}
