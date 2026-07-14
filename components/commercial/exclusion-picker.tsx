"use client";

/**
 * <ExclusionPicker> — Phase F.0 client component.
 *
 * Multi-select combobox over the Exclusions Library. Standard rows are
 * pre-selected (auto-added to every proposal per Katie's spec); user
 * can uncheck them per-proposal if a specific bid doesn't need them.
 * Optional rows are hand-picked via the search input; "add to library"
 * fallback creates a new commercial_exclusions row on-the-fly.
 *
 * Emits `<input type="hidden" name={namePrefix + "exclusion_ids"}>` with
 * JSON-encoded UUID array so the server action can parse.
 *
 * Full ARIA: role=combobox, aria-expanded, aria-controls,
 * aria-activedescendant on the input; role=listbox with role=option +
 * aria-selected inside the popover.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";

type Row = {
  id: string;
  text: string;
  category: "standard" | "optional";
  use_count: number;
};

export type ExclusionPickerProps = {
  /** `to_` or `""` — matches the naming convention on the form. */
  namePrefix?: "" | "to_";
  /** Pre-selected exclusion rows (usually the standard-category rows
   *  hydrated server-side for a new proposal). */
  initialSelected?: Row[];
  /** Phase F.5: text lines added as "one-off for this proposal only".
   *  Persist to commercial_proposals.custom_exclusions, NOT the shared
   *  library. Rendered after the library chips. */
  initialCustom?: string[];
  /** Optional label above the picker. */
  label?: string;
  /** Show the "add to library" inline fallback. */
  allowInlineAdd?: boolean;
  className?: string;
};

export function ExclusionPicker({
  namePrefix = "",
  initialSelected = [],
  initialCustom = [],
  label = "Exclusions",
  allowInlineAdd = true,
  className = "",
}: ExclusionPickerProps) {
  const [selected, setSelected] = useState<Row[]>(initialSelected);
  const [customLines, setCustomLines] = useState<string[]>(initialCustom);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Row[]>([]);
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [addingNew, setAddingNew] = useState(false);
  /** F.5: when true, inline-add stores text in customLines instead of
   *  creating a shared library row. Default OFF (matches prior
   *  library-add behavior) so existing muscle memory works unchanged. */
  const [oneOffMode, setOneOffMode] = useState(false);
  /** Round-3 audit fix: brief transient hint when a duplicate custom
   *  line is typed so the input clear isn't silent. */
  const [dupHint, setDupHint] = useState<string | null>(null);
  const dupHintTimerRef = useRef<number>(0);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootId = useId();
  const listboxId = `${rootId}-listbox`;

  const standardCount = selected.filter((s) => s.category === "standard").length;
  const optionalCount = selected.filter((s) => s.category === "optional").length;
  const customCount = customLines.length;

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const url = `/api/commercial/exclusions/search?q=${encodeURIComponent(query)}`;
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) return;
        const json = (await res.json()) as { exclusions: Row[] };
        // Filter out already-selected rows so the picker never suggests
        // dupes.
        const selectedIds = new Set(selected.map((s) => s.id));
        setResults(json.exclusions.filter((r) => !selectedIds.has(r.id)));
        setHighlightIdx(json.exclusions.length > 0 ? 0 : -1);
      } catch (e) {
        if ((e as { name?: string }).name === "AbortError") return;
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 120);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query, open, selected]);

  const idsJson = useMemo(() => JSON.stringify(selected.map((s) => s.id)), [selected]);
  const customJson = useMemo(() => JSON.stringify(customLines), [customLines]);

  const addRow = (r: Row) => {
    setSelected((prev) => [...prev, r]);
    setQuery("");
    setResults([]);
    setHighlightIdx(-1);
    inputRef.current?.focus();
  };

  const removeRow = (id: string) => {
    setSelected((prev) => prev.filter((s) => s.id !== id));
  };

  const addCustomLine = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Round-3 audit fix: was silent-clear on duplicate; now surfaces a
    // brief inline hint so Alex sees why the input didn't take.
    if (customLines.some((c) => c.trim().toLowerCase() === trimmed.toLowerCase())) {
      setDupHint("Already added to this proposal.");
      window.clearTimeout(dupHintTimerRef.current);
      dupHintTimerRef.current = window.setTimeout(() => setDupHint(null), 2000);
      setQuery("");
      return;
    }
    setDupHint(null);
    setCustomLines((prev) => [...prev, trimmed]);
    setQuery("");
    setResults([]);
    setHighlightIdx(-1);
    inputRef.current?.focus();
  };

  const removeCustomLine = (idx: number) => {
    setCustomLines((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlightIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && highlightIdx >= 0 && results[highlightIdx]) {
      e.preventDefault();
      addRow(results[highlightIdx]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const handleInlineAdd = async () => {
    const text = query.trim();
    if (!text || addingNew) return;
    // F.5: one-off mode stores text on the proposal only; no shared
    // library row.
    if (oneOffMode) {
      addCustomLine(text);
      return;
    }
    setAddingNew(true);
    try {
      const res = await fetch("/api/commercial/exclusions/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return;
      const json = (await res.json().catch(() => ({}))) as { exclusion?: Row };
      // F.0 post-audit fix: null-guard against malformed / empty
      // response so a network hiccup can't crash the picker with
      // "cannot read properties of undefined".
      if (!json.exclusion || !json.exclusion.id) return;
      addRow(json.exclusion);
    } finally {
      setAddingNew(false);
    }
  };

  return (
    <div className={`space-y-2 ${className}`}>
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <label htmlFor={`${rootId}-input`} className="block text-[13px] font-semibold text-ppp-charcoal-800">
          {label}
        </label>
        {(selected.length > 0 || customCount > 0) && (
          <span className="text-[11px] text-ppp-charcoal-500 tabular-nums">
            {standardCount > 0 && <>{standardCount} standard</>}
            {standardCount > 0 && (optionalCount > 0 || customCount > 0) && " · "}
            {optionalCount > 0 && <>{optionalCount} optional</>}
            {optionalCount > 0 && customCount > 0 && " · "}
            {customCount > 0 && <>{customCount} one-off</>}
          </span>
        )}
      </div>
      <p className="text-[12px] text-ppp-charcoal-500 leading-snug">
        Add or remove exclusions for this proposal only. Standard exclusions are pre-added but you can remove any of them. Type a new one to add to the shared library, or toggle <em>one-off</em> below to add it to this proposal only.
      </p>

      {/* Selected library chips */}
      {selected.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {selected.map((s) => (
            <li key={s.id}>
              <span
                className={`inline-flex items-center gap-1.5 pl-2.5 pr-1 py-1 rounded-md text-[12px] border ${
                  s.category === "standard"
                    ? "bg-cc-brand-50 text-cc-brand-800 border-cc-brand-200"
                    : "bg-ppp-charcoal-50 text-ppp-charcoal-800 border-ppp-charcoal-200"
                }`}
              >
                <span className="truncate max-w-[260px]" title={s.text}>
                  {s.text}
                </span>
                <button
                  type="button"
                  onClick={() => removeRow(s.id)}
                  aria-label={`Remove ${s.text} from this proposal`}
                  title="Remove from this proposal"
                  className="inline-flex items-center justify-center w-6 h-6 rounded hover:bg-black/10 focus:outline-none focus:ring-2 focus:ring-cc-brand-600/40"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden>
                    <path d="M18 6L6 18 M6 6l12 12" />
                  </svg>
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* One-off custom lines (this proposal only, NOT in library) */}
      {customLines.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-700">
            One-off · this proposal only
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {customLines.map((line, i) => (
              <li key={`${i}-${line}`}>
                <span className="inline-flex items-center gap-1.5 pl-2.5 pr-1 py-1 rounded-md text-[12px] border bg-emerald-50 text-emerald-800 border-emerald-200">
                  <span className="truncate max-w-[260px]" title={line}>
                    {line}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeCustomLine(i)}
                    aria-label={`Remove one-off exclusion "${line}"`}
                    title="Remove this one-off exclusion"
                    className="inline-flex items-center justify-center w-6 h-6 rounded hover:bg-black/10 focus:outline-none focus:ring-2 focus:ring-emerald-600/40"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden>
                      <path d="M18 6L6 18 M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Combobox input */}
      <div className="relative">
        <input
          ref={inputRef}
          id={`${rootId}-input`}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={
            highlightIdx >= 0 && results[highlightIdx]
              ? `${rootId}-opt-${results[highlightIdx].id}`
              : undefined
          }
          aria-autocomplete="list"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={handleKeyDown}
          placeholder="Search exclusions or type a new one…"
          className="w-full px-3 py-2 text-base sm:text-sm bg-white border border-ppp-charcoal-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 min-h-[40px]"
        />

        {open && (results.length > 0 || (allowInlineAdd && query.trim())) && (
          <ul
            id={listboxId}
            role="listbox"
            className="absolute z-20 top-full mt-1 w-full max-h-72 overflow-y-auto bg-white border border-ppp-charcoal-200 rounded-lg shadow-lg divide-y divide-ppp-charcoal-100"
          >
            {loading && results.length === 0 && (
              <li className="px-3 py-2 text-[12px] text-ppp-charcoal-500 italic">Searching…</li>
            )}
            {results.map((r, i) => (
              <li
                key={r.id}
                id={`${rootId}-opt-${r.id}`}
                role="option"
                aria-selected={i === highlightIdx}
                onMouseDown={(e) => {
                  e.preventDefault();
                  addRow(r);
                }}
                onMouseEnter={() => setHighlightIdx(i)}
                className={`px-3 py-2 text-[13px] cursor-pointer flex items-start gap-2 ${
                  i === highlightIdx
                    ? "bg-cc-brand-50 text-cc-brand-900"
                    : "text-ppp-charcoal-800 hover:bg-ppp-charcoal-50"
                }`}
              >
                <span
                  className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-widest shrink-0 border ${
                    r.category === "standard"
                      ? "bg-cc-brand-100 text-cc-brand-800 border-cc-brand-200"
                      : "bg-ppp-charcoal-100 text-ppp-charcoal-700 border-ppp-charcoal-200"
                  }`}
                >
                  {r.category}
                </span>
                <span className="flex-1">{r.text}</span>
                {r.use_count > 0 && (
                  <span className="text-[10px] text-ppp-charcoal-500 tabular-nums shrink-0">
                    {r.use_count}×
                  </span>
                )}
              </li>
            ))}
            {allowInlineAdd && query.trim() && !loading && (
              <li className="px-3 py-2">
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleInlineAdd();
                  }}
                  disabled={addingNew}
                  className={`text-[12px] font-semibold disabled:opacity-50 ${
                    oneOffMode
                      ? "text-emerald-700 hover:text-emerald-800"
                      : "text-cc-brand-700 hover:text-cc-brand-800"
                  }`}
                >
                  {addingNew
                    ? "Adding…"
                    : oneOffMode
                      ? `+ Add “${query.trim()}” to this proposal only`
                      : `+ Add “${query.trim()}” to shared library`}
                </button>
              </li>
            )}
          </ul>
        )}
      </div>

      {dupHint && (
        <p className="text-[12px] text-amber-700 -mt-1" role="status" aria-live="polite">
          {dupHint}
        </p>
      )}

      {/* One-off toggle — controls what happens when Alex types a new
          exclusion and clicks "Add …". Default off = library, on =
          this-proposal-only. */}
      {allowInlineAdd && (
        <label className="inline-flex items-center gap-2 text-[12px] text-ppp-charcoal-600 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={oneOffMode}
            onChange={(e) => setOneOffMode(e.target.checked)}
            className="w-4 h-4 accent-emerald-600"
          />
          <span>
            One-off · new additions go to <strong>this proposal only</strong> (won&rsquo;t appear on future proposals)
          </span>
        </label>
      )}

      {/* Hidden JSON payloads for form submit. */}
      <input type="hidden" name={`${namePrefix}exclusion_ids`} value={idsJson} />
      <input type="hidden" name={`${namePrefix}custom_exclusions`} value={customJson} />
    </div>
  );
}

export default ExclusionPicker;
