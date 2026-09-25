"use client";

import { useState } from "react";

/**
 * A number field that puts the thousands separators in as you type.
 *
 * Brendan 2026-09-23: "when adding the quantity if it's like 1000
 * automatically add a comma, and same goes for everywhere else as well."
 *
 * Reading 12000 off a proposal line and deciding whether it is twelve thousand
 * or a hundred and twenty is the kind of check nobody should have to do on a
 * document that becomes a contract.
 *
 * Three things it deliberately does NOT do:
 *
 *  · It never reformats while a decimal is mid-flight. Typing "1000." or
 *    "1000.5" leaves the tail alone — grouping the integer part only — so the
 *    caret does not jump and a half-typed "2.5" cannot become "25".
 *  · It never blocks a keystroke. Anything that is not a number yet is passed
 *    through untouched, because a field that fights the typist is worse than
 *    one that is briefly unformatted.
 *  · It does not strip the commas back out on submit. That is the SERVER's
 *    job, and it is already done: every money parser here strips `[$,\s]`, and
 *    quantity now goes through `quantityInputToNumber`. Relying on client-side
 *    cleanup would mean a paste, an autofill, or a disabled-JS submit silently
 *    posting a value the parser reads as 1.
 */
export function GroupedNumberInput({
  name,
  defaultValue,
  className,
  placeholder,
  id,
  ariaLabel,
}: {
  name: string;
  defaultValue?: string | number;
  className?: string;
  placeholder?: string;
  id?: string;
  ariaLabel?: string;
}) {
  const [value, setValue] = useState(() => group(String(defaultValue ?? "")));

  return (
    <input
      type="text"
      inputMode="decimal"
      name={name}
      id={id}
      aria-label={ariaLabel}
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(group(e.target.value))}
      className={className}
    />
  );
}

/** "1000" → "1,000"; "1000.5" → "1,000.5"; "abc" → "abc" (left alone). */
export function group(raw: string): string {
  if (!raw) return raw;
  const bare = raw.replace(/,/g, "");
  // Only touch something that is actually a number so far. A trailing "." or a
  // partial decimal is legal input mid-typing, hence the optional tail.
  const m = /^(\d+)(\.\d*)?$/.exec(bare);
  if (!m) return raw;
  const [, whole, decimals] = m;
  return `${Number(whole).toLocaleString("en-US")}${decimals ?? ""}`;
}
