"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { SearchableSelect } from "@/components/commercial/searchable-select";
import type { NavChoice } from "@/components/commercial/nav-select";

/**
 * NavSelect for a list too long to scroll: the same "every option is a URL"
 * filter control, as a type-to-search box.
 *
 * Built for the Purchases tab's vendor picker — a hundred-odd vendors is well
 * past where a native dropdown is usable, and Mary is typing a name she knows.
 * The hrefs come from the server, exactly as NavSelect's do, so this never
 * learns the page's URL grammar. Clearing the box goes to the `""` choice.
 */
export function NavSearchSelect({
  label,
  value,
  choices,
  placeholder,
  ariaLabel,
}: {
  label: string;
  value: string;
  choices: NavChoice[];
  placeholder?: string;
  ariaLabel?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const hrefOf = new Map(choices.map((c) => [c.value, c.href]));

  return (
    <div className="flex items-center gap-1.5 min-w-0 w-full sm:w-auto">
      <span className="text-[9.5px] font-bold uppercase tracking-widest text-ppp-charcoal-400 shrink-0">
        {label}
      </span>
      <div className="min-w-0 flex-1 sm:w-64 sm:flex-none">
        <SearchableSelect
          // Not inside a form; the name only satisfies the component.
          name="nav_search_select"
          options={choices.filter((c) => c.value !== "").map((c) => ({ value: c.value, label: c.label }))}
          defaultValue={value}
          placeholder={placeholder}
          ariaLabel={ariaLabel ?? label}
          disabled={pending}
          onChange={({ value: next }) => {
            if (next === value) return;
            const href = hrefOf.get(next) ?? hrefOf.get("");
            if (href) startTransition(() => router.push(href));
          }}
        />
      </div>
    </div>
  );
}
