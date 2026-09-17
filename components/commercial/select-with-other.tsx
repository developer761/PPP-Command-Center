"use client";

import { useState } from "react";

import { INPUT_CLS, SELECT_CLS, SELECT_BG_STYLE } from "@/lib/commercial/form-classnames";

/**
 * A picker whose "Other" actually lets you say what it was.
 *
 * Karan 2026-09-17: "when I choose Other on the platform, it should give me an
 * option to enter something manually."
 *
 * Before this, choosing Other recorded the word "Other" and nothing else — the
 * one option that means "none of these fit" was the one that threw away the
 * only information worth keeping. A month later the Purchases list has eleven
 * rows saying Other and no way to tell a dumpster hire from a parking permit.
 *
 * WHERE THE TEXT GOES. There is no column for it, and inventing one means a
 * migration applied by hand on a live book. So the typed value is folded into
 * the free-text field the row already has — Reference on a purchase — joined
 * with an em dash if something is already there. That keeps it visible in the
 * list (Reference is a column Mary reads) and loses nothing she typed. The
 * category itself still records `other`, so the cost buckets are unaffected.
 */
export function SelectWithOther({
  name,
  options,
  defaultValue,
  otherValue = "other",
  otherName,
  otherLabel,
  otherPlaceholder,
  selectClassName = SELECT_CLS,
  selectStyle = SELECT_BG_STYLE,
  inputClassName = INPUT_CLS,
  ariaLabel,
}: {
  name: string;
  options: { value: string; label: string }[];
  defaultValue?: string;
  /** The option that means "none of these". */
  otherValue?: string;
  /** Field name the typed text is posted under. */
  otherName: string;
  otherLabel: string;
  otherPlaceholder: string;
  /** Defaults to the platform's select styling — the OS chrome is dropped
   *  platform-wide, and a control that opts out of it is the one that looks
   *  broken. Only override for a genuinely different context. */
  selectClassName?: string;
  selectStyle?: React.CSSProperties;
  inputClassName?: string;
  ariaLabel?: string;
}) {
  const [value, setValue] = useState(defaultValue ?? options[0]?.value ?? "");
  const showOther = value === otherValue;

  return (
    <>
      <select
        name={name}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className={selectClassName}
        style={selectStyle}
        aria-label={ariaLabel}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {showOther && (
        // Rendered only when it applies. A box that is always there but usually
        // irrelevant is a box people fill in by accident.
        <label className="block mt-2">
          <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-1">{otherLabel}</span>
          <input
            name={otherName}
            placeholder={otherPlaceholder}
            maxLength={120}
            autoFocus
            className={inputClassName}
          />
        </label>
      )}
    </>
  );
}
