"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { FILTER_SELECT_CLS, SELECT_BG_STYLE_COMPACT } from "@/lib/commercial/form-classnames";

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
 * The chrome comes from `FILTER_SELECT_CLS`, NOT from classes written here.
 * That module exists because Karan has flagged the OS's grey dropdown four
 * times; the first cut of this component wrapped a bare `<select>` in a border
 * and got the grey bar back, because without `appearance-none` the browser
 * paints its own control inside whatever box you draw around it.
 *
 * The label sits OUTSIDE the control rather than inside a box with it — one
 * bordered element per dimension, not a box within a box.
 *
 * The hrefs are built on the SERVER by whatever helper owns that page's query
 * string, so this component never learns the URL grammar and can't drift from
 * the page's own links. It only pushes the href it was handed. Still a real URL
 * per option: the view stays shareable, refreshable, and Back-button-able.
 */

export type NavChoice = { value: string; label: string; href: string };

export function NavSelect({
  label,
  value,
  choices,
  ariaLabel,
}: {
  /** Small standing label beside the control ("Billed", "Type", "GC"). */
  label: string;
  value: string;
  choices: NavChoice[];
  ariaLabel?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <label className="inline-flex items-center gap-1.5">
      <span className="text-[9.5px] font-bold uppercase tracking-widest text-ppp-charcoal-400 shrink-0">
        {label}
      </span>
      <select
        value={value}
        aria-label={ariaLabel ?? label}
        disabled={pending}
        style={SELECT_BG_STYLE_COMPACT}
        onChange={(e) => {
          const next = choices.find((c) => c.value === e.target.value);
          // Unknown value can't happen from the UI, but never navigate to
          // undefined if it ever does.
          if (next) startTransition(() => router.push(next.href));
        }}
        className={`${FILTER_SELECT_CLS} ${pending ? "opacity-60" : ""}`}
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
