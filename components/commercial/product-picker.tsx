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

export type PickableProduct = {
  id: string;
  sku: string;
  name: string;
  category: string;
  unit: string;
  default_unit_price_cents: number;
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
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products.slice(0, 25);
    // Prefix match first (SKU + name), then substring — mirrors the
    // Karan-approved SearchableSelect behavior across the platform.
    const prefixSku: PickableProduct[] = [];
    const prefixName: PickableProduct[] = [];
    const substring: PickableProduct[] = [];
    for (const p of products) {
      const sku = p.sku.toLowerCase();
      const name = p.name.toLowerCase();
      if (sku.startsWith(q)) prefixSku.push(p);
      else if (name.startsWith(q)) prefixName.push(p);
      else if (sku.includes(q) || name.includes(q)) substring.push(p);
    }
    return [...prefixSku, ...prefixName, ...substring].slice(0, 25);
  }, [products, query]);

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
    setPicked(p);
    setQuery(p.name);
    setOpen(false);
    setFormValue(productIdInputId, p.id);
    // Instant defaults so the row is usable even before the price
    // resolve API returns.
    setFormValue(descriptionInputId, p.name);
    setFormValue(unitInputId, p.unit);
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
                className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 inline-flex items-center justify-center rounded-md text-ppp-charcoal-400 hover:text-ppp-charcoal hover:bg-ppp-charcoal-50"
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

      {open && results.length > 0 && (
        <ul
          ref={listRef}
          id="product-picker-listbox"
          role="listbox"
          className="absolute z-30 left-0 right-0 mt-1 max-h-72 overflow-y-auto rounded-lg border border-ppp-charcoal-200 bg-white shadow-lg"
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
              className={`px-3 py-2 cursor-pointer border-b border-ppp-charcoal-50 last:border-b-0 ${
                idx === highlight
                  ? "bg-cc-brand-50"
                  : "hover:bg-ppp-charcoal-50"
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold text-ppp-charcoal truncate">
                    {p.name}
                  </div>
                  <div className="text-[11px] text-ppp-charcoal-500 flex items-center gap-x-2">
                    <span className="font-mono">{p.sku}</span>
                    <span aria-hidden className="text-ppp-charcoal-300">·</span>
                    <span>per {p.unit}</span>
                  </div>
                </div>
                <div className="text-[12.5px] font-bold tabular-nums text-ppp-charcoal shrink-0">
                  {formatDollars(p.default_unit_price_cents)}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {open && query.trim() && results.length === 0 && (
        <div className="absolute z-30 left-0 right-0 mt-1 rounded-lg border border-ppp-charcoal-200 bg-white shadow-lg p-3 text-[12.5px] text-ppp-charcoal-500">
          No products match &ldquo;{query}&rdquo;. Keep typing the row as free
          text below or{" "}
          <a
            href="/commercial/pre-job/products/new"
            className="text-cc-brand-700 font-semibold hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            add it to the catalog
          </a>
          .
        </div>
      )}
    </div>
  );
}
