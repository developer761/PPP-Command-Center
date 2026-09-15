"use client";

/**
 * Reusable searchable-combobox that mimics a native `<select>` API but
 * lets users type-to-filter through long option lists.
 *
 * Karan 2026-07-10: standing rule — any dropdown with more than
 * ~10 items must be searchable. Prefix + substring ranked matching so
 * typing "B" surfaces "Bob" before "Robert" (prefix wins). Applies to
 * every existing large-list picker AND every future phase (Product
 * Library, Tomco price list, etc.). See memory rule
 * feedback_searchable_dropdowns.md.
 *
 * Behavior:
 * - Text input + filtered dropdown list beneath.
 * - Prefix matches rank first, substring matches second, case-insensitive.
 * - Arrow keys navigate the filtered list; Enter selects highlighted.
 * - Escape closes the popover.
 * - Empty query = show ALL options (up to a soft cap).
 * - "×" clear button resets both the query and the selected value.
 * - A hidden `<input type="hidden" name={name} value={selectedValue} />`
 *   preserves the FK/UUID for server actions, so it drops into
 *   existing form-action call sites without any server-side changes.
 * - Optional `disabled` matches native select.
 * - `allowFreeText` mode: when true, if the user types something that
 *   doesn't match any option, the typed value itself is submitted (used
 *   by the estimator picker where free-text is a first-class value).
 * - `createLabel` (optional): when the typed text isn't an option, a last,
 *   tappable row — "Add 'Joe's Hardware' as a new vendor" — commits the
 *   typed text and reports `created: true` through `onChange`. One tap, no
 *   detour to another page. Implies free text for that value.
 * - `group` on an option (optional): options are shown grouped in the order
 *   their groups first appear, with a small header per group, and matches rank
 *   INSIDE their group. Lets a caller say "labor vendors first" and keep it
 *   true while the user types.
 * - `onChange` (optional): the committed value, the option it came from, and
 *   whether it was the create row — for a client parent that needs more than
 *   the hidden input (e.g. a second hidden id).
 *
 * NOT a full ARIA combobox implementation — no listbox role wiring for
 * screen readers yet. If Katie or Alex needs SR support we upgrade.
 * Today's users (Alex + PPP staff) are sighted desktop users.
 */

import { useEffect, useId, useRef, useState } from "react";

export type SearchableOption = {
  /** Value written to FormData under `name`. Typically a UUID. */
  value: string;
  /** Text shown in the input + list. */
  label: string;
  /** Optional secondary line (email, role, category, etc.) shown small. */
  hint?: string;
  /** Optional section. Options render grouped, groups in first-seen order. */
  group?: string;
};

export type SearchableSelectChange = {
  value: string;
  option: SearchableOption | null;
  /** True when the value came from the `createLabel` row. */
  created: boolean;
};

export function SearchableSelect({
  name,
  options,
  defaultValue = "",
  placeholder = "Search…",
  required = false,
  disabled = false,
  ariaLabel,
  allowFreeText = false,
  emptyMessage = "No matches. Try a different search.",
  maxVisible = 100,
  className = "",
  createLabel,
  onChange,
  id: idProp,
}: {
  name: string;
  options: SearchableOption[];
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  /** When true, user-typed text that doesn't match any option is submitted
   *  as-is under `name`. Used by the estimator picker where "type any name"
   *  is a valid path. */
  allowFreeText?: boolean;
  emptyMessage?: string;
  maxVisible?: number;
  className?: string;
  /** Label for the "add what I typed" row. Omit — or return null for a query
   *  the caller already knows is not new — for no such row. */
  createLabel?: (query: string) => string | null;
  onChange?: (change: SearchableSelectChange) => void;
  /** id for the visible input, so an external <label htmlFor> can point at it. */
  id?: string;
}) {
  const initialOption =
    options.find((o) => o.value === defaultValue) ?? null;
  const [query, setQuery] = useState<string>(initialOption?.label ?? defaultValue);
  const [selectedValue, setSelectedValue] = useState<string>(defaultValue);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<number>(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const autoId = useId();
  const id = idProp ?? autoId;
  // Every committed value goes through here, so an optional client parent
  // hears about all of them (pick, create, exact-typed match, clear).
  const commitValue = (value: string, option: SearchableOption | null, created: boolean) => {
    setSelectedValue(value);
    onChange?.({ value, option, created });
  };

  // Close the popover when the user clicks outside the component. Uses
  // pointerdown for parity with Enter/Escape close paths.
  useEffect(() => {
    if (!open) return;
    const handler = (e: PointerEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", handler);
    return () => window.removeEventListener("pointerdown", handler);
  }, [open]);

  // Rank + filter the options against the current query. Case-insensitive.
  // Prefix matches rank above substring matches. Uses a stable sort by
  // input order for equally-ranked options.
  const normalizedQuery = query.trim().toLowerCase();
  const ranked: Array<SearchableOption & { rank: number }> = [];
  if (normalizedQuery === "") {
    // Empty query → show everything, no ranking.
    for (const o of options) ranked.push({ ...o, rank: 0 });
  } else {
    for (const o of options) {
      const label = o.label.toLowerCase();
      const hint = (o.hint ?? "").toLowerCase();
      if (label.startsWith(normalizedQuery)) {
        ranked.push({ ...o, rank: 0 });
      } else if (label.includes(normalizedQuery)) {
        ranked.push({ ...o, rank: 1 });
      } else if (hint.startsWith(normalizedQuery)) {
        ranked.push({ ...o, rank: 2 });
      } else if (hint.includes(normalizedQuery)) {
        ranked.push({ ...o, rank: 3 });
      }
    }
    ranked.sort((a, b) => a.rank - b.rank);
  }
  // Grouped callers: keep each group together (first-seen order), rank inside.
  // Array.prototype.sort is stable, so the rank order survives within a group.
  const groupOrder = new Map<string, number>();
  for (const o of options) if (o.group !== undefined && !groupOrder.has(o.group)) groupOrder.set(o.group, groupOrder.size);
  if (groupOrder.size > 0) {
    ranked.sort((a, b) => (groupOrder.get(a.group ?? "") ?? groupOrder.size) - (groupOrder.get(b.group ?? "") ?? groupOrder.size));
  }
  const visible = ranked.slice(0, maxVisible);
  // The "add what I typed" row — only when it would add something new.
  const typed = query.trim();
  const createText =
    createLabel && typed !== "" && !options.some((o) => o.label.trim().toLowerCase() === typed.toLowerCase())
      ? createLabel(typed)
      : null;
  const showCreate = createText !== null;
  const rowCount = visible.length + (showCreate ? 1 : 0);
  const createIndex = showCreate ? visible.length : -1;

  // Keep the highlight in range when the list shrinks — derived during render
  // rather than corrected in an effect, which painted one frame with nothing
  // highlighted and then re-rendered.
  const hi = highlight < rowCount ? highlight : 0;

  // Scroll the highlighted option into view as the user arrows through a long
  // list (Karan 2026-07-27 audit — the list is max-h-64 overflow-y-auto).
  useEffect(() => {
    if (!open) return;
    const el = document.getElementById(`${id}-opt-${hi}`);
    el?.scrollIntoView({ block: "nearest" });
  }, [hi, open, id]);

  const commitOption = (opt: SearchableOption) => {
    setQuery(opt.label);
    commitValue(opt.value, opt, false);
    setOpen(false);
  };
  const commitCreate = () => {
    setQuery(typed);
    commitValue(typed, null, true);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      // From the closed state, the first ArrowDown should highlight option 0,
      // not skip to 1 (Karan 2026-07-27 audit).
      if (!open) {
        setOpen(true);
        setHighlight(0);
        return;
      }
      setHighlight(Math.min(hi + 1, Math.max(0, rowCount - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight(Math.max(0, hi - 1));
    } else if (e.key === "Enter") {
      if (open && hi === createIndex) {
        e.preventDefault();
        commitCreate();
      } else if (open && visible[hi]) {
        e.preventDefault();
        commitOption(visible[hi]!);
      } else if (allowFreeText && normalizedQuery !== "") {
        // Fallthrough — form-submit handles the raw typed value via
        // the hidden input below (set on onChange).
        setOpen(false);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-label={ariaLabel}
          aria-activedescendant={open && hi < rowCount ? `${id}-opt-${hi}` : undefined}
          value={query}
          required={required}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => {
            const next = e.target.value;
            setQuery(next);
            setOpen(true);
            setHighlight(0);
            // Sync the hidden value to what the user is typing.
            //   • exact label match      → select that option
            //   • allowFreeText          → submit the raw text
            //   • field emptied          → clear the selection (unset)
            //   • otherwise (partial)    → KEEP the current selection
            // 2026-07-21 re-audit (#5): the old code cleared the value on
            // ANY partial/non-matching keystroke, so focusing an existing
            // selection and typing one character (without clicking a
            // result) then saving silently nulled it — e.g. reverting a
            // product variation to standalone, losing its parent link.
            // Preserving the last valid selection until the user actively
            // picks a new one, clears via ×, or empties the field avoids
            // that destructive path. (Native <select> couldn't null it.)
            const exact = options.find(
              (o) => o.label.toLowerCase() === next.trim().toLowerCase()
            );
            if (exact) {
              commitValue(exact.value, exact, false);
            } else if (allowFreeText || createLabel) {
              commitValue(next.trim(), null, false);
            } else if (next.trim() === "") {
              commitValue("", null, false);
            }
            // else: partial non-match — leave selectedValue untouched.
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          autoComplete="off"
          className="w-full px-3 py-2 pr-9 text-base sm:text-sm bg-surface border border-ppp-charcoal-200 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 hover:border-ppp-charcoal-300 min-h-[44px] transition-colors disabled:bg-ppp-charcoal-50 disabled:cursor-not-allowed"
        />
        {/* Clear button — visible when there's a query OR a selection.
            Focus-visible outline so keyboard users still get feedback. */}
        {(query !== "" || selectedValue !== "") && !disabled && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              commitValue("", null, false);
              setOpen(false);
              inputRef.current?.focus();
            }}
            aria-label="Clear selection"
            className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-7 h-7 rounded-full text-ppp-charcoal-400 hover:text-ppp-charcoal-800 hover:bg-ppp-charcoal-100 focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 6L6 18 M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
      {open && (
        <ul
          id={`${id}-list`}
          role="listbox"
          className="absolute z-30 left-0 right-0 mt-1 max-h-64 overflow-y-auto bg-surface border border-ppp-charcoal-200 rounded-lg shadow-lg py-1 text-sm"
        >
          {visible.length === 0 && !showCreate ? (
            <li className="px-3 py-2 text-ppp-charcoal-500 italic">
              {allowFreeText && normalizedQuery !== ""
                ? `Use "${query.trim()}" as manual entry`
                : emptyMessage}
            </li>
          ) : (
            visible.map((opt, i) => [
              opt.group !== undefined && opt.group !== visible[i - 1]?.group ? (
                <li
                  key={`group-${opt.group}`}
                  role="presentation"
                  className="px-3 pt-2 pb-1 text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-500 bg-ppp-charcoal-50/70 border-y border-ppp-charcoal-100 first:border-t-0"
                >
                  {opt.group}
                </li>
              ) : null,
              <li
                key={opt.value}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={selectedValue === opt.value}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => commitOption(opt)}
                className={`px-3 py-2.5 min-h-[44px] cursor-pointer flex items-center justify-between gap-3 touch-manipulation ${
                  i === hi ? "bg-cc-brand-50" : "hover:bg-ppp-charcoal-50"
                } ${selectedValue === opt.value ? "font-semibold" : ""}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-ppp-charcoal-800 break-words">{opt.label}</div>
                  {opt.hint && (
                    <div className="text-[11px] text-ppp-charcoal-500 mt-0.5 truncate">
                      {opt.hint}
                    </div>
                  )}
                </div>
                {selectedValue === opt.value && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-cc-brand-600 shrink-0" aria-hidden>
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                )}
              </li>,
            ])
          )}
          {showCreate && (
            <li
              id={`${id}-opt-${createIndex}`}
              role="option"
              aria-selected={false}
              onMouseEnter={() => setHighlight(createIndex)}
              onClick={commitCreate}
              className={`px-3 py-2.5 min-h-[44px] cursor-pointer flex items-center gap-2.5 touch-manipulation border-t border-ppp-charcoal-100 font-semibold text-cc-brand-700 ${
                hi === createIndex ? "bg-cc-brand-50" : "hover:bg-ppp-charcoal-50"
              }`}
            >
              <span aria-hidden className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-cc-brand-600 text-white shrink-0">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 5v14 M5 12h14" />
                </svg>
              </span>
              <span className="min-w-0 break-words">{createText}</span>
            </li>
          )}
          {ranked.length > maxVisible && (
            <li className="px-3 py-1.5 text-[11px] text-ppp-charcoal-400 italic border-t border-ppp-charcoal-100">
              Showing top {maxVisible} of {ranked.length}. Type to narrow.
            </li>
          )}
        </ul>
      )}
      {/* Hidden form value — this is what the server action reads. `required`
          lives on the VISIBLE combobox input above (a hidden input is exempt
          from constraint validation, so requiring it here was a no-op — Karan
          2026-07-27 audit). */}
      <input type="hidden" name={name} value={selectedValue} />
    </div>
  );
}
