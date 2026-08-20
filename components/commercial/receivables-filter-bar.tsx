import Link from "next/link";
import { ACTIVITY_PRESETS } from "@/lib/commercial/reports/presets";
import { receivableQueryString, type ReceivableQuery } from "@/lib/commercial/reports/receivables-filters";
import type { ReceivableKind } from "@/lib/commercial/reports/receivables";

/**
 * Filters for the receivables book — Karan, 2026-08-19: *"can we have filters
 * like by day, week, monthly, year"*.
 *
 * Link-based, not a client form: each control is a URL, so a filtered view is
 * shareable, survives a refresh, works with the browser Back button, and needs
 * no JavaScript. Mary can send Alex the link to "everything overdue on this GC".
 *
 * The period filters on WHEN IT WAS BILLED, not when it comes due — "what did
 * we bill in July that's still out" is the question people actually ask. It
 * defaults to All time, and that default is load-bearing: an ageing book
 * narrowed to this month hides exactly the old debt it exists to surface.
 */

const KINDS: { key: ReceivableKind | "all"; label: string }[] = [
  { key: "all", label: "Everything" },
  { key: "invoice", label: "Invoices" },
  { key: "aia", label: "AIA" },
  { key: "retainage", label: "Retention" },
];

export function ReceivablesFilterBar({
  q,
  basePath,
  gcOptions,
  extraParams = {},
}: {
  q: ReceivableQuery;
  /** The page these links point at. MUST be a bare path with no query string:
   *  an HTML GET form DISCARDS the query in `action` and replaces it with the
   *  form data set, so a `?view=receivables` baked in here would be dropped by
   *  the GC picker and bounce the user to a different view. Anything that has
   *  to survive goes in `extraParams`, which is rendered as hidden inputs. */
  basePath: string;
  /** GCs present in the UNFILTERED book, so the picker never offers a name
   *  that yields nothing, and never hides one because it's filtered out. */
  gcOptions: { id: string; name: string }[];
  /** Params to preserve on every control (e.g. `{ view: "receivables" }`). */
  extraParams?: Record<string, string>;
}) {
  const to = (patch: Partial<ReceivableQuery>) =>
    `${basePath}${receivableQueryString({ ...q, ...patch }, extraParams)}`;

  return (
    <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-3 space-y-2.5">
      <FilterRow label="Billed">
        {ACTIVITY_PRESETS.map((p) => (
          <Chip key={p.key} href={to({ period: p.key })} active={q.period === p.key}>
            {p.label}
          </Chip>
        ))}
      </FilterRow>

      <FilterRow label="Type">
        {KINDS.map((k) => (
          <Chip key={k.key} href={to({ kind: k.key })} active={q.kind === k.key}>
            {k.label}
          </Chip>
        ))}
        <span className="w-px self-stretch bg-ppp-charcoal-100 mx-1 hidden sm:block" aria-hidden />
        <Chip href={to({ overdueOnly: !q.overdueOnly })} active={q.overdueOnly} tone="rose">
          Overdue only
        </Chip>
      </FilterRow>

      {gcOptions.length > 1 && (
        <FilterRow label="GC">
          {/* A GET form, so this works without JS like every other control here.
              Hidden inputs carry the other filters — otherwise picking a GC
              would silently reset the period you had chosen. */}
          <form action={basePath} method="GET" className="flex items-center gap-1.5 flex-wrap">
            {Object.entries(extraParams).map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
            {q.period !== "all" && <input type="hidden" name="period" value={q.period} />}
            {q.kind !== "all" && <input type="hidden" name="kind" value={q.kind} />}
            {q.overdueOnly && <input type="hidden" name="overdue" value="1" />}
            <select
              name="gc"
              defaultValue={q.accountId ?? ""}
              aria-label="Filter by GC"
              className="px-2.5 py-1.5 text-base sm:text-[12.5px] bg-surface border border-ppp-charcoal-200 rounded-lg min-h-[40px] max-w-[240px] focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600"
            >
              <option value="">Every GC</option>
              {gcOptions.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
            <button
              type="submit"
              className="inline-flex items-center px-3 rounded-lg border border-ppp-charcoal-200 bg-surface text-[12px] font-semibold text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 min-h-[40px]"
            >
              Apply
            </button>
          </form>
        </FilterRow>
      )}

      {(q.period !== "all" || q.kind !== "all" || q.overdueOnly || q.accountId) && (
        <div className="pt-0.5">
          <Link
            href={`${basePath}${new URLSearchParams(extraParams).toString() ? `?${new URLSearchParams(extraParams).toString()}` : ""}`}
            className="text-[11.5px] font-semibold text-cc-brand-700 hover:underline inline-flex items-center min-h-[32px]"
          >
            Clear filters
          </Link>
        </div>
      )}
    </div>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[9.5px] font-bold uppercase tracking-widest text-ppp-charcoal-400 w-[42px] shrink-0">
        {label}
      </span>
      {children}
    </div>
  );
}

function Chip({
  href, active, children, tone = "brand",
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
  tone?: "brand" | "rose";
}) {
  const on =
    tone === "rose"
      ? "bg-rose-600 text-white border-rose-700"
      : "bg-cc-brand-600 text-white border-cc-brand-600";
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={`inline-flex items-center px-2.5 rounded-lg text-[12px] font-semibold border transition-colors min-h-[36px] touch-manipulation ${
        active ? on : "bg-surface text-ppp-charcoal-600 border-ppp-charcoal-200 hover:bg-ppp-charcoal-50"
      }`}
    >
      {children}
    </Link>
  );
}
