"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  SELECT_CLS,
  SELECT_BG_STYLE,
  INPUT_CLS,
  TEXTAREA_CLS,
  LABEL_CLS,
} from "@/lib/commercial/form-classnames";

/**
 * Win/Loss Debrief Fields — reactive add-on to the opp status-change form.
 *
 * Uses the platform's shared SELECT_CLS / INPUT_CLS / TEXTAREA_CLS /
 * LABEL_CLS classnames so the styling matches every other form on the
 * Commercial CC (Karan flagged the gray default-select look — never use
 * raw browser controls here).
 *
 * The deciding-factor picker is rendered as a button-grid (radio inputs
 * styled as toggle pills) instead of a dropdown — faster to pick on
 * mobile + visually clearer than a select for a 7-option choice set.
 *
 * Mount this INSIDE the existing form so it submits with the same
 * FormData. When the sibling status select is non-terminal we render
 * nothing (no spacer, no flicker). When terminal, the section fades in
 * and exposes:
 *   - debrief_competitor (typeahead, auto-create on save)
 *   - debrief_deciding_factor (button-grid, required for lost/no_bid)
 *   - debrief_lessons (textarea, optional but encouraged)
 *   - debrief_internal_notes (textarea, optional)
 *
 * The "skip" path is exposed via a SEPARATE secondary action button
 * rendered alongside (parent owns the buttons — this component just
 * sets `debrief_skip="1"` hidden field when the button is clicked).
 */

const TERMINAL_STATUSES = new Set(["won", "lost", "no_bid"]);

type Props = {
  initialStatus?: string;
  initialCompetitor?: string;
  initialDecidingFactor?: string;
  initialLessons?: string;
  initialInternalNotes?: string;
};

const DECIDING_FACTORS: Array<{ value: string; label: string }> = [
  { value: "price", label: "Price" },
  { value: "scope", label: "Scope" },
  { value: "timing", label: "Timing" },
  { value: "relationship", label: "Relationship" },
  { value: "awarded_to_competitor", label: "Lost to competitor" },
  { value: "no_decision", label: "No decision" },
  { value: "other", label: "Other" },
];

export default function DebriefFields(props: Props) {
  const initial = props.initialStatus?.toLowerCase() ?? "";
  const [terminal, setTerminal] = useState<"won" | "lost" | "no_bid" | null>(
    TERMINAL_STATUSES.has(initial) ? (initial as "won" | "lost" | "no_bid") : null
  );

  // Watch the sibling status dropdown without needing a Context provider.
  useEffect(() => {
    const select = document.querySelector<HTMLSelectElement>('select[name="to_status"]');
    if (!select) return;
    const onChange = () => {
      const v = select.value.toLowerCase();
      setTerminal(TERMINAL_STATUSES.has(v) ? (v as "won" | "lost" | "no_bid") : null);
    };
    select.addEventListener("change", onChange);
    onChange();
    return () => select.removeEventListener("change", onChange);
  }, []);

  // Legacy loss_reason + note fields were removed from the parent form
  // 2026-06-24 — no DOM siblings to hide anymore. The data-form-field
  // toggle effect went with them. DebriefFields now just renders (or
  // doesn't) based on terminal status.
  if (!terminal) return null;

  const headerCopy = terminal === "won"
    ? { title: "Win Debrief", sub: "Capture what sealed it." }
    : terminal === "lost"
    ? { title: "Loss Debrief", sub: "Capture who won + why. Feeds the quarterly review." }
    : { title: "No-Bid Debrief", sub: "Why we passed on this one." };

  const factorRequired = terminal !== "won";

  return (
    <section
      data-debrief
      className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50/30 overflow-hidden animate-fade-up"
      aria-label="Win/Loss debrief"
    >
      <header className="px-4 sm:px-5 pt-4 pb-3 border-b border-emerald-100 bg-emerald-50/60">
        <h3 className="text-sm font-semibold text-ppp-charcoal">
          {headerCopy.title}
        </h3>
        <p className="text-[12px] text-ppp-charcoal-500 mt-0.5">
          {headerCopy.sub}
        </p>
      </header>

      <div className="px-4 sm:px-5 py-4 space-y-4">
        <CompetitorTypeahead
          outcome={terminal}
          initialValue={props.initialCompetitor ?? ""}
        />

        <div>
          <label className={LABEL_CLS}>
            {terminal === "won" ? "What sealed it?" : "Deciding factor"}
            {factorRequired && <span className="text-rose-700 ml-1">*</span>}
          </label>
          <FactorButtonGrid
            initialValue={props.initialDecidingFactor ?? ""}
            required={factorRequired}
          />
        </div>

        <div>
          <label htmlFor="debrief_lessons" className={LABEL_CLS}>
            {terminal === "won" ? "What worked? (optional)" : "What would we do differently? (optional)"}
          </label>
          <textarea
            id="debrief_lessons"
            name="debrief_lessons"
            defaultValue={props.initialLessons ?? ""}
            rows={3}
            maxLength={2000}
            placeholder={
              terminal === "won"
                ? "e.g. Our portfolio sold them — lean harder on portfolio in pitches."
                : "e.g. We quoted 6 months but they wanted 4. Stop padding K-12 timelines."
            }
            className={`${TEXTAREA_CLS} min-h-[88px]`}
          />
        </div>

        <details className="group">
          <summary className="cursor-pointer text-[12px] font-medium text-ppp-charcoal-500 hover:text-ppp-charcoal select-none min-h-[28px] flex items-center gap-1.5">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="transition-transform group-open:rotate-90" aria-hidden>
              <path d="M9 18l6-6-6-6" />
            </svg>
            Add internal notes
          </summary>
          <textarea
            name="debrief_internal_notes"
            defaultValue={props.initialInternalNotes ?? ""}
            rows={2}
            maxLength={2000}
            placeholder="Anything else not captured above — private to the team."
            className={`mt-2 ${TEXTAREA_CLS} min-h-[66px]`}
          />
        </details>
      </div>
    </section>
  );
}

/** Button-grid replacement for the deciding-factor dropdown.
 *  Renders one toggle button per factor; the chosen value is written
 *  into a hidden input the form picks up. Better UX than a select on
 *  mobile (single tap), better visual hierarchy than radio dots. */
function FactorButtonGrid({
  initialValue,
  required,
}: {
  initialValue: string;
  required: boolean;
}) {
  const [picked, setPicked] = useState(initialValue);

  return (
    <>
      <input
        type="hidden"
        name="debrief_deciding_factor"
        value={picked}
        required={required && !picked}
      />
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {DECIDING_FACTORS.map((f) => {
          const active = picked === f.value;
          return (
            <button
              key={f.value}
              type="button"
              onClick={() => setPicked(active ? "" : f.value)}
              className={`px-3 py-2.5 rounded-xl text-sm font-medium border transition-colors min-h-[44px] touch-manipulation ${
                active
                  ? "bg-emerald-600 text-white border-emerald-600 shadow-sm shadow-emerald-600/20"
                  : "bg-white text-ppp-charcoal border-ppp-charcoal-200 hover:border-ppp-charcoal-300 hover:bg-ppp-charcoal-50"
              }`}
              aria-pressed={active}
            >
              {f.label}
            </button>
          );
        })}
      </div>
      {required && !picked && (
        <p className="text-[11px] text-ppp-charcoal-400 mt-2">
          Pick the main deciding factor.
        </p>
      )}
    </>
  );
}

function CompetitorTypeahead({
  outcome,
  initialValue,
}: {
  outcome: "won" | "lost" | "no_bid";
  initialValue: string;
}) {
  const [query, setQuery] = useState(initialValue);
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/commercial/competitors?q=${encodeURIComponent(query)}`);
        if (res.ok) {
          const data = await res.json();
          setSuggestions(data.competitors ?? []);
        }
      } catch {
        setSuggestions([]);
      } finally {
        setLoading(false);
      }
    }, 180);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener("mousedown", onClick);
      return () => document.removeEventListener("mousedown", onClick);
    }
  }, [open]);

  const fuzzyHint = useMemo(() => {
    if (!query.trim()) return null;
    const lower = query.trim().toLowerCase();
    const exact = suggestions.find((s) => s.name.toLowerCase() === lower);
    if (exact) return null;
    const close = suggestions.find(
      (s) =>
        s.name.toLowerCase().startsWith(lower) ||
        s.name.toLowerCase().includes(lower)
    );
    return close ? `Did you mean ${close.name}?` : null;
  }, [query, suggestions]);

  const label =
    outcome === "won" ? "Who'd we beat? (optional)" : "Who won it?";
  const required = outcome === "lost"; // lost requires; won + no_bid optional

  return (
    <div ref={wrapperRef} className="relative">
      <label htmlFor="debrief_competitor" className={LABEL_CLS}>
        {label}
        {required && <span className="text-rose-700 ml-1">*</span>}
      </label>
      <input
        ref={inputRef}
        id="debrief_competitor"
        name="debrief_competitor"
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        required={required}
        autoComplete="off"
        placeholder="Type to search or add a new competitor"
        className={INPUT_CLS}
      />
      {fuzzyHint && !open && (
        <p className="text-[10px] text-amber-700 mt-1">{fuzzyHint}</p>
      )}
      {open && (query.length > 0 || suggestions.length > 0) && (
        <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-white border border-ppp-charcoal-200 rounded-xl shadow-lg max-h-60 overflow-y-auto">
          {loading && suggestions.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-ppp-charcoal-500">Searching…</div>
          ) : suggestions.length === 0 ? (
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="block w-full text-left px-3 py-2.5 text-sm text-emerald-700 hover:bg-emerald-50 min-h-[44px]"
            >
              + Add &quot;{query}&quot; as new competitor
            </button>
          ) : (
            <>
              {suggestions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setQuery(s.name);
                    setOpen(false);
                    inputRef.current?.focus();
                  }}
                  className="block w-full text-left px-3 py-2.5 text-sm hover:bg-ppp-charcoal-50 text-ppp-charcoal min-h-[44px]"
                >
                  {s.name}
                </button>
              ))}
              {!suggestions.some((s) => s.name.toLowerCase() === query.trim().toLowerCase()) && query.trim().length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                  }}
                  className="block w-full text-left px-3 py-2.5 text-sm text-emerald-700 hover:bg-emerald-50 border-t border-ppp-charcoal-100 min-h-[44px]"
                >
                  + Add &quot;{query.trim()}&quot; as new competitor
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Hint for the parent page to consume — kept as a named const so we can
// import + reuse the value in a kanban-side modal later.
export { SELECT_CLS, SELECT_BG_STYLE };
