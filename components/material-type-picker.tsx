"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MATERIAL_TYPES, filterMaterialTypesForWorkOrder, type MaterialType } from "@/lib/customer-form/material-types";

/**
 * Material Type picker with three asks Katie 2026-06-05 called out for the
 * incoming ~100-product list:
 *
 *  1. **Categorized + collapsible groups** — BM Interior, BM Exterior, SW,
 *     Behr, etc. all collapsed by default once the list grows; click a
 *     header to expand.
 *  2. **Search bar** — typing filters across product names + group labels
 *     so a customer searching "Aura" lands instantly without scrolling.
 *  3. **Dynamic per-WO** — already handled by filterMaterialTypesForWorkOrder
 *     (interior-only WO hides exterior products, etc.). The picker just
 *     accepts the filtered groups via the `availableValues` prop.
 *
 * Mobile: opens as a bottom-sheet-ish dropdown anchored to the trigger.
 * Touch-friendly tap targets (≥44px on mobile, 32px on desktop). Close
 * on outside tap, Esc, or selection.
 *
 * Used by:
 *  - components/customer-form-view.tsx (the customer-facing job-level pick)
 *  - components/supplier-order-modal.tsx (the per-color admin override)
 *
 * Empty value (`""`) = "use default" / nothing picked. Honoring this string
 * means the existing skip-when-blank submit + writeback paths work unchanged.
 */
type Props = {
  /** Current value. Empty string = nothing picked / use default. */
  value: string;
  /** Called on every selection change. Pass "" to clear. */
  onChange: (next: string) => void;
  /** Optional set of legal values for this context (e.g. WO-filtered list).
   *  When omitted, the full MATERIAL_TYPES set is shown. */
  availableValues?: ReadonlySet<string>;
  /** Trigger button label when nothing's picked. */
  placeholder?: string;
  /** Smaller "compact" trigger used in the per-color row inside the
   *  supplier-order modal — defaults to false (full-width trigger). */
  compact?: boolean;
  /** Optional id for the trigger button (a11y — label[for] linkage). */
  id?: string;
  /** Optional class added to the trigger. */
  triggerClassName?: string;
  /** When true, the "— use default —" choice appears at the top so admin
   *  can explicitly clear an override. Disabled by default (customer form
   *  uses a placeholder option instead). */
  allowClear?: boolean;
};

export default function MaterialTypePicker({
  value,
  onChange,
  availableValues,
  placeholder = "Select a product line",
  compact = false,
  id,
  triggerClassName,
  allowClear = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Visible options after the WO-context filter + the search query.
  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Group MATERIAL_TYPES preserving source order; honor availableValues
    // (the WO-filtered allowlist) + the search query at the same time so
    // an empty group doesn't render an empty header.
    const groups = new Map<string, MaterialType[]>();
    for (const m of MATERIAL_TYPES) {
      if (availableValues && !availableValues.has(m.value)) continue;
      if (q) {
        const matchesValue = m.value.toLowerCase().includes(q);
        const matchesGroup = m.group.toLowerCase().includes(q);
        if (!matchesValue && !matchesGroup) continue;
      }
      const bucket = groups.get(m.group);
      if (bucket) bucket.push(m);
      else groups.set(m.group, [m]);
    }
    return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
  }, [availableValues, query]);

  // Auto-expand all groups when the query is active (search results should
  // all be visible at once); collapse back to default on clear.
  const effectiveExpanded = useMemo<Set<string>>(() => {
    if (query.trim()) return new Set(visibleGroups.map((g) => g.label));
    // Default: expand groups where the current value lives + the first
    // group if nothing's picked. Avoids burying the picked value behind
    // a closed accordion.
    if (expanded.size > 0) return expanded;
    if (value) {
      const m = MATERIAL_TYPES.find((x) => x.value === value);
      if (m) return new Set<string>([m.group]);
    }
    return visibleGroups.length > 0 ? new Set<string>([visibleGroups[0].label]) : new Set<string>();
  }, [expanded, query, value, visibleGroups]);

  const toggleGroup = (label: string) => {
    setExpanded(() => {
      // Seed from the currently-visible set (which may be the auto-expanded
      // fallback when the user hasn't manually toggled anything yet). This
      // means the user's first click "locks in" the current visible state +
      // their toggle — a minor wart, acceptable for the realistic use of
      // tap-to-collapse-one-group.
      const next: Set<string> = new Set(effectiveExpanded);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  // Close on outside click + Esc. Same pattern as the existing color picker.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const root = rootRef.current;
      if (!root) return;
      if (!root.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Auto-focus the search input on open — the whole point of the search bar
  // is to type immediately rather than scrolling 100 items.
  useEffect(() => {
    if (open) {
      // Defer one tick so the input is mounted before we focus it.
      const t = setTimeout(() => searchRef.current?.focus(), 30);
      return () => clearTimeout(t);
    } else {
      setQuery("");
    }
  }, [open]);

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative inline-block w-full">
      <button
        id={id}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={
          triggerClassName ??
          (compact
            ? "text-[11px] sm:text-[10px] px-2 py-1 border border-ppp-charcoal-100 rounded bg-white text-ppp-charcoal max-w-[180px] truncate focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue inline-flex items-center gap-1.5"
            : "w-full px-3 py-3 sm:py-2.5 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg bg-white text-left focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue inline-flex items-center justify-between gap-2")
        }
      >
        <span className={value ? "text-ppp-charcoal truncate" : "text-ppp-charcoal-500 truncate"}>
          {value || placeholder}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className={["shrink-0 transition-transform duration-150", open ? "rotate-180" : ""].join(" ")}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          role="listbox"
          className={[
            "absolute left-0 right-0 mt-1 z-40 bg-white border border-ppp-charcoal-100 rounded-lg shadow-xl shadow-ppp-charcoal/15",
            // Sized for ~100 products without scrolling the page. Internal
            // scroll keeps the search bar visible.
            "max-h-[60vh] flex flex-col overflow-hidden",
            compact ? "min-w-[260px] sm:min-w-[280px]" : "min-w-full",
          ].join(" ")}
        >
          <div className="p-2 border-b border-ppp-charcoal-100 bg-[var(--color-surface-muted)]/60">
            <input
              ref={searchRef}
              type="search"
              inputMode="search"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search products…"
              className="w-full px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue bg-white"
            />
          </div>
          <div className="flex-1 overflow-y-auto">
            {allowClear && (
              <button
                type="button"
                role="option"
                aria-selected={!value}
                onClick={() => pick("")}
                className={[
                  "w-full text-left px-3 py-2.5 sm:py-2 text-sm border-b border-ppp-charcoal-100 hover:bg-ppp-charcoal-50 active:bg-ppp-charcoal-100 transition-colors touch-manipulation",
                  !value ? "font-semibold text-ppp-blue-700" : "text-ppp-charcoal-500 italic",
                ].join(" ")}
              >
                — Use default (no override) —
              </button>
            )}
            {visibleGroups.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-ppp-charcoal-500 italic">
                No products match &ldquo;{query}&rdquo;.
              </div>
            ) : (
              visibleGroups.map((g) => {
                const isExpanded = effectiveExpanded.has(g.label);
                return (
                  <div key={g.label} className="border-b border-ppp-charcoal-100 last:border-b-0">
                    <button
                      type="button"
                      onClick={() => toggleGroup(g.label)}
                      className="w-full flex items-center justify-between px-3 py-2.5 sm:py-2 text-xs font-semibold uppercase tracking-wider text-ppp-charcoal-700 hover:bg-ppp-charcoal-50 active:bg-ppp-charcoal-100 transition-colors touch-manipulation"
                      aria-expanded={isExpanded}
                    >
                      <span className="text-left flex items-center gap-2">
                        {g.label}
                        <span className="text-[10px] font-normal text-ppp-charcoal-500 normal-case tracking-normal">
                          ({g.items.length})
                        </span>
                      </span>
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                        className={["transition-transform duration-150", isExpanded ? "rotate-180" : ""].join(" ")}
                      >
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </button>
                    {isExpanded && (
                      <ul>
                        {g.items.map((m) => {
                          const selected = m.value === value;
                          return (
                            <li key={m.value}>
                              <button
                                type="button"
                                role="option"
                                aria-selected={selected}
                                onClick={() => pick(m.value)}
                                className={[
                                  "w-full text-left px-5 py-2.5 sm:py-2 text-sm border-t border-ppp-charcoal-50 first:border-t-0 hover:bg-ppp-blue-50/60 active:bg-ppp-blue-50 transition-colors touch-manipulation",
                                  selected ? "font-semibold text-ppp-blue-700 bg-ppp-blue-50/40" : "text-ppp-charcoal",
                                ].join(" ")}
                              >
                                {m.value}
                                {selected && (
                                  <span className="ml-2 text-[10px] uppercase tracking-wider text-ppp-blue-700 font-bold">
                                    ✓
                                  </span>
                                )}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
