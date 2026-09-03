"use client";

/**
 * A money field that groups its digits, so a mis-keyed zero is visible.
 *
 * Brendan 2026-09-03: "Can we please add some number formatting. Small detail
 * but it will help us not make mistakes when entering."
 *
 * He is right that it is small and right that it matters. `250000` and `25000`
 * are one glance apart in a bare input and an order of magnitude apart on a
 * proposal; `250,000.00` and `25,000.00` are not mistakable. On a document
 * where the number IS the product, that is worth a component.
 *
 * Formats on BLUR, not on every keystroke. Live formatting has to re-place the
 * caret after every insertion, and it puts it in the wrong spot often enough
 * that people fight the field — worse than no formatting on the one screen
 * where accuracy is the whole point. Tabbing out is immediate feedback and the
 * value you typed stays exactly as typed while you are typing it.
 *
 * Posts the grouped string, which is safe: every parser behind these fields
 * (`dollarsInputToCents`, `parseDollarsToCents`) strips `$`, commas and spaces
 * before reading. Verified rather than assumed — a formatter that posts
 * something the server silently reads as 0 would be far worse than no
 * formatter.
 */

import { useState } from "react";

function group(raw: string): string {
  const cleaned = raw.replace(/[$,\s]/g, "").trim();
  if (!cleaned) return "";
  // Leave anything unparseable exactly as typed. Rewriting a value we don't
  // understand is how a typo turns into a confidently wrong number.
  if (!/^-?\d*\.?\d*$/.test(cleaned)) return raw;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return raw;
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function MoneyInput({
  name,
  defaultValue,
  id,
  className,
  placeholder,
  required,
  "aria-label": ariaLabel,
}: {
  name: string;
  defaultValue?: string | number | null;
  id?: string;
  className?: string;
  placeholder?: string;
  required?: boolean;
  "aria-label"?: string;
}) {
  const [value, setValue] = useState(() => group(String(defaultValue ?? "")));
  return (
    <input
      type="text"
      // "decimal" keeps the numeric keypad on a phone. NOT type="number":
      // it rejects the commas this component exists to show, and its scroll-
      // to-change behaviour can silently alter a price on a trackpad.
      inputMode="decimal"
      id={id}
      name={name}
      required={required}
      aria-label={ariaLabel}
      placeholder={placeholder}
      className={className}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={(e) => setValue(group(e.target.value))}
      onFocus={(e) => {
        // Strip the grouping while editing so arrow keys and select-all behave
        // like a plain number field; it comes back on blur.
        const bare = e.target.value.replace(/[$,\s]/g, "");
        if (bare !== e.target.value) setValue(bare);
      }}
    />
  );
}
