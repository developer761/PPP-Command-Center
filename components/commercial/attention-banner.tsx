import Link from "next/link";
import type { Attention } from "@/lib/commercial/opportunities/attention";

/**
 * The blocking-condition banner, as seen on the Salesforce quote — except ours
 * doesn't block.
 *
 * Sits directly under the status path so it reads as a property of where the
 * job IS, not a stray alert. Each row names the missing thing AND what it
 * affects: "Missing X" on its own gives nobody a reason to act today.
 *
 * There is no dismiss control, on purpose. These persist until the underlying
 * thing is fixed — a warning you can dismiss is one people learn to dismiss.
 */
export function AttentionBanner({ items }: { items: Attention[] }) {
  if (items.length === 0) return null;
  const warn = items.some((i) => i.tone === "warn");
  return (
    <section
      aria-label="Needs attention"
      className={`rounded-xl border overflow-hidden ${
        warn ? "border-amber-200 bg-amber-50" : "border-cc-brand-200 bg-cc-brand-50"
      }`}
    >
      <ul className="divide-y divide-black/[0.06]">
        {items.map((it) => (
          <li key={it.key} className="flex items-start gap-2.5 px-3.5 py-2.5">
            <span
              aria-hidden
              className={`mt-[3px] shrink-0 ${warn ? "text-amber-700" : "text-cc-brand-700"}`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 9v4 M12 17h.01 M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              <p
                className={`text-[12.5px] font-bold leading-snug ${
                  warn ? "text-amber-900" : "text-cc-brand-900"
                }`}
              >
                {it.title}
              </p>
              <p
                className={`text-[11.5px] leading-relaxed mt-0.5 ${
                  warn ? "text-amber-800" : "text-cc-brand-800"
                }`}
              >
                {it.consequence}
              </p>
            </div>
            {it.href && (
              <Link
                href={it.href}
                className={`shrink-0 self-center inline-flex items-center px-2.5 py-1.5 rounded-lg border bg-surface text-[11.5px] font-bold min-h-[44px] sm:min-h-[32px] ${
                  warn
                    ? "border-amber-300 text-amber-900 hover:bg-amber-100"
                    : "border-cc-brand-200 text-cc-brand-800 hover:bg-cc-brand-100"
                }`}
              >
                Fix
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
