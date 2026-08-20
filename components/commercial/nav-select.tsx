"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * A filter control that IS a link — a labelled dropdown whose every option is
 * a URL, navigated the moment you pick one.
 *
 * Built for filter bars that have more than one or two dimensions. As rows of
 * chips, four dimensions is twenty-odd buttons and a block taller than the
 * table it filters (Karan, 2026-08-19: *"its all like spread out and
 * cumbersome"*). Collapsed to labelled dropdowns it is one line, and the
 * current value of every dimension is readable at a glance instead of being
 * inferred from which chip is coloured in.
 *
 * The hrefs are built on the SERVER by whatever helper owns that page's query
 * string, so this component never learns the URL grammar and can't drift from
 * the page's own links. It only pushes the href it was handed.
 *
 * Still a real URL per option: the view stays shareable, refreshable, and
 * Back-button-able, exactly as the chips were.
 */

export type NavChoice = { value: string; label: string; href: string };

export function NavSelect({
  label,
  value,
  choices,
  ariaLabel,
  widthClassName = "",
}: {
  /** Small standing label inside the control ("Billed", "Type", "GC"). */
  label: string;
  value: string;
  choices: NavChoice[];
  ariaLabel?: string;
  widthClassName?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <label
      className={`inline-flex items-center gap-1.5 pl-2.5 pr-1.5 bg-surface border border-ppp-charcoal-200 rounded-lg min-h-[38px] focus-within:ring-2 focus-within:ring-cc-brand-600/30 focus-within:border-cc-brand-600 transition-colors ${
        pending ? "opacity-60" : ""
      }`}
    >
      <span className="text-[9.5px] font-bold uppercase tracking-widest text-ppp-charcoal-400 shrink-0">
        {label}
      </span>
      <select
        value={value}
        aria-label={ariaLabel ?? label}
        disabled={pending}
        onChange={(e) => {
          const next = choices.find((c) => c.value === e.target.value);
          // Unknown value can't happen from the UI, but never navigate to
          // undefined if it ever does.
          if (next) startTransition(() => router.push(next.href));
        }}
        className={`bg-transparent text-base sm:text-[12.5px] font-semibold text-ppp-charcoal py-1.5 pr-1 focus:outline-none cursor-pointer max-w-[190px] truncate ${widthClassName}`}
      >
        {choices.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
    </label>
  );
}
