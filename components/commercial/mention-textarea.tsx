"use client";

import { useEffect, useRef, useState, useCallback } from "react";

/**
 * Textarea with @ mention autocomplete.
 *
 * Behavior:
 *   - Type `@` → fetch team-member candidates → show a popup below the
 *     caret with the matching subset.
 *   - Continue typing → filter the popup live (debounced 100ms).
 *   - ArrowDown / ArrowUp navigate the popup, Enter or click selects,
 *     Escape closes it.
 *   - Selecting inserts the user's email at the caret + closes popup.
 *
 * Server-side, the note-creation lib re-parses the body via the same
 * regex used here and resolves emails → profile.user_id values, so the
 * client can't forge a notification target by hand-editing the body.
 * The autocomplete is purely a typing convenience.
 *
 * Mobile-friendly:
 *   - Popup is position:absolute under the textarea — never blocks
 *     keyboard or input
 *   - 44px row height on candidates
 *   - text-base (16px) on the textarea to dodge iOS auto-zoom
 *
 * Props mirror the underlying <textarea>; pass `name` so the form
 * submits the value through the existing server action.
 */

type Candidate = {
  user_id: string;
  email: string;
  full_name: string | null;
};

export default function MentionTextarea({
  name,
  defaultValue = "",
  placeholder,
  required,
  maxLength,
  rows = 4,
  className = "",
  candidates,
  helperText,
}: {
  name: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
  maxLength?: number;
  rows?: number;
  className?: string;
  /** Pre-fetched team members shown in the autocomplete popup. */
  candidates: Candidate[];
  helperText?: string;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(defaultValue);
  const [popupOpen, setPopupOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [popupTop, setPopupTop] = useState(0);
  const [popupLeft, setPopupLeft] = useState(0);

  const filtered = candidates.filter((c) => {
    if (!filter) return true;
    const f = filter.toLowerCase();
    return c.email.toLowerCase().includes(f) || (c.full_name?.toLowerCase().includes(f) ?? false);
  }).slice(0, 8);

  // Reset active row when filter changes
  useEffect(() => {
    setActiveIdx(0);
  }, [filter]);

  const onChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    setValue(next);
    const caret = e.target.selectionStart ?? next.length;
    // Find the last @ before the caret, with no whitespace in between
    const upto = next.slice(0, caret);
    const at = upto.lastIndexOf("@");
    if (at < 0) {
      setPopupOpen(false);
      return;
    }
    const fragment = upto.slice(at + 1);
    if (/\s/.test(fragment)) {
      setPopupOpen(false);
      return;
    }
    setFilter(fragment);
    setPopupOpen(true);
    // Anchor popup to bottom-left of the textarea (good enough +
    // works on mobile + bullet-proof against viewport overflow).
    const rect = e.target.getBoundingClientRect();
    setPopupTop(rect.bottom + window.scrollY);
    setPopupLeft(rect.left + window.scrollX);
  }, []);

  const selectCandidate = useCallback(
    (c: Candidate) => {
      const ta = taRef.current;
      if (!ta) return;
      const caret = ta.selectionStart ?? value.length;
      const upto = value.slice(0, caret);
      const at = upto.lastIndexOf("@");
      if (at < 0) return;
      const before = value.slice(0, at);
      const after = value.slice(caret);
      const insert = `@${c.email} `;
      const next = `${before}${insert}${after}`;
      setValue(next);
      setPopupOpen(false);
      // Restore caret after React updates the DOM
      requestAnimationFrame(() => {
        if (!taRef.current) return;
        const pos = before.length + insert.length;
        taRef.current.focus();
        taRef.current.setSelectionRange(pos, pos);
      });
    },
    [value]
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!popupOpen || filtered.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % filtered.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + filtered.length) % filtered.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        selectCandidate(filtered[activeIdx] ?? filtered[0]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setPopupOpen(false);
      }
    },
    [popupOpen, filtered, activeIdx, selectCandidate]
  );

  return (
    <div className="relative">
      <textarea
        ref={taRef}
        name={name}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setPopupOpen(false), 120)}
        placeholder={placeholder}
        required={required}
        maxLength={maxLength}
        rows={rows}
        // text-base (16px) so iOS Safari doesn't auto-zoom on focus.
        // touch-manipulation lets long-press select work normally on
        // mobile without delayed click registration.
        className={`w-full text-base px-3 py-2.5 rounded-lg border border-ppp-charcoal-100 bg-white text-ppp-charcoal focus:outline-none focus:ring-2 focus:ring-ppp-blue focus:border-ppp-blue touch-manipulation min-h-[44px] ${className}`}
      />
      {helperText && (
        <p className="mt-1 text-[11px] text-ppp-charcoal-500 leading-relaxed">
          {helperText}
        </p>
      )}
      {popupOpen && filtered.length > 0 && (
        <ul
          role="listbox"
          aria-label="Mention a team member"
          // Fixed-position popup so it doesn't get clipped by any parent
          // overflow:hidden. Sits just below the textarea.
          style={{ top: popupTop, left: popupLeft, position: "absolute" }}
          className="z-50 mt-1 w-72 max-w-[calc(100vw-32px)] bg-white border border-ppp-charcoal-100 rounded-lg shadow-lg overflow-hidden"
        >
          {filtered.map((c, i) => (
            <li key={c.user_id}>
              <button
                type="button"
                // onMouseDown beats onClick because onBlur fires before
                // a tap-and-release on mobile would have fired onClick.
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectCandidate(c);
                }}
                onMouseEnter={() => setActiveIdx(i)}
                aria-selected={i === activeIdx}
                className={`block w-full text-left px-3 py-2.5 touch-manipulation min-h-[44px] ${
                  i === activeIdx
                    ? "bg-ppp-blue-50 text-ppp-charcoal"
                    : "bg-white text-ppp-charcoal-700 hover:bg-ppp-blue-50"
                } transition-colors`}
              >
                <div className="text-sm font-medium truncate">
                  {c.full_name || c.email.split("@")[0]}
                </div>
                <div className="text-xs text-ppp-charcoal-500 truncate font-mono">
                  {c.email}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
