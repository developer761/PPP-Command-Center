"use client";

import { useEffect, useRef, useState } from "react";

type Option<T extends string> = { value: T; label: string };

type Props<T extends string> = {
  value: T;
  options: Option<T>[];
  onChange: (next: T) => void;
  /** Short label that appears above/before the chosen value, e.g. "Period" */
  srLabel?: string;
  /** Optional icon at the left of the trigger */
  icon?: React.ReactNode;
};

export default function FilterDropdown<T extends string>({
  value,
  options,
  onChange,
  srLabel,
  icon,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState<number>(() =>
    Math.max(0, options.findIndex((o) => o.value === value))
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const current = options.find((o) => o.value === value) ?? options[0];

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onTriggerKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Guard against empty options — `% 0` throws RangeError in V8.
    if (options.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIndex((i) => (i + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIndex((i) => (i - 1 + options.length) % options.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      setFocusedIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setFocusedIndex(options.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const opt = options[focusedIndex];
      if (!opt) return;
      onChange(opt.value);
      setOpen(false);
      buttonRef.current?.focus();
    }
  };

  return (
    <div className="relative" ref={rootRef}>
      {srLabel && <span className="sr-only">{srLabel}</span>}
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKey}
        className={[
          "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium",
          "bg-white border border-ppp-charcoal-100 text-ppp-charcoal",
          "hover:border-ppp-blue-200 hover:text-ppp-blue-700 hover:bg-ppp-blue-50/40",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-ppp-blue/40",
          "transition-colors whitespace-nowrap",
          open ? "border-ppp-blue-200 text-ppp-blue-700 bg-ppp-blue-50/40" : "",
        ].join(" ")}
      >
        {icon && <span className="text-ppp-charcoal-500">{icon}</span>}
        <span>{current.label}</span>
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
          className={["transition-transform duration-150", open ? "rotate-180" : ""].join(" ")}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          role="listbox"
          tabIndex={-1}
          onKeyDown={onMenuKey}
          className={[
            "absolute right-0 mt-1.5 z-40 min-w-[180px] py-1 rounded-lg",
            "max-w-[calc(100vw-2rem)]",
            "bg-white border border-ppp-charcoal-100",
            "shadow-xl shadow-ppp-charcoal/15",
            "focus:outline-none",
            "animate-fade-in",
          ].join(" ")}
        >
          {options.map((opt, i) => {
            const selected = opt.value === value;
            const focused = i === focusedIndex;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={selected}
                onMouseEnter={() => setFocusedIndex(i)}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                  buttonRef.current?.focus();
                }}
                className={[
                  "w-full text-left flex items-center justify-between gap-3 px-3 py-1.5 text-xs",
                  selected
                    ? "text-ppp-blue-700 font-semibold"
                    : "text-ppp-charcoal font-medium",
                  focused ? "bg-ppp-blue-50/60" : "hover:bg-ppp-charcoal-50",
                  "transition-colors",
                ].join(" ")}
              >
                <span>{opt.label}</span>
                {selected && (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                    className="text-ppp-blue"
                  >
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
