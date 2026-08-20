import Link from "next/link";
import { ACTIVITY_PRESETS } from "@/lib/commercial/reports/presets";
import { receivableQueryString, type ReceivableQuery } from "@/lib/commercial/reports/receivables-filters";
import { NavSelect, type NavChoice } from "@/components/commercial/nav-select";
import type { ReceivableKind } from "@/lib/commercial/reports/receivables";

/**
 * Filters for the receivables book — Karan, 2026-08-19: *"can we have filters
 * like by day, week, monthly, year"*.
 *
 * ONE LINE. This was four labelled rows of chips — twenty-odd buttons, a block
 * taller than the table beneath it (Karan, same day: *"its all like spread out
 * and cumbersome"*). Four filter dimensions is too many for chips: they can
 * only show one dimension per row, so the bar grows with every dimension while
 * saying less, because "what is the current Type?" means scanning a row for
 * whichever pill is coloured in.
 *
 * As labelled dropdowns each dimension states its own current value in place,
 * the whole bar is one wrapping row, and adding a fifth dimension costs no
 * vertical space at all.
 *
 * Every option is still a URL — the dropdowns navigate to hrefs built here, on
 * the server, by the same helper the rest of the page uses. A filtered view
 * stays shareable, refreshable and Back-able: Mary can still send Alex the link
 * to "everything overdue on this GC".
 *
 * "Overdue only" stays a chip on purpose. It is binary, it is the highest
 * traffic control on a chase list, and a two-option dropdown to toggle one flag
 * is a worse trade than one tap.
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

const SORTS: { key: ReceivableQuery["sort"]; label: string }[] = [
  // Not a filter — nothing is hidden, only reordered. "Most overdue" is how you
  // clear the tail of a book; "Biggest" is how you protect the month.
  { key: "amount", label: "Biggest first" },
  { key: "oldest", label: "Most overdue first" },
];

export function ReceivablesFilterBar({
  q,
  basePath,
  gcOptions,
  extraParams = {},
}: {
  q: ReceivableQuery;
  /** The page these links point at. A bare path with no query string — the
   *  query is built here, per control, from `q` + `extraParams`. */
  basePath: string;
  /** GCs present in the UNFILTERED book, so the picker never offers a name
   *  that yields nothing, and never hides one because it's filtered out. */
  gcOptions: { id: string; name: string }[];
  /** Params to preserve on every control (e.g. `{ view: "receivables" }`). */
  extraParams?: Record<string, string>;
}) {
  const to = (patch: Partial<ReceivableQuery>) =>
    `${basePath}${receivableQueryString({ ...q, ...patch }, extraParams)}`;

  const periodChoices: NavChoice[] = ACTIVITY_PRESETS.map((p) => ({
    value: p.key,
    label: p.label,
    href: to({ period: p.key }),
  }));
  const kindChoices: NavChoice[] = KINDS.map((k) => ({
    value: k.key,
    label: k.label,
    href: to({ kind: k.key }),
  }));
  const sortChoices: NavChoice[] = SORTS.map((s) => ({
    value: s.key,
    label: s.label,
    href: to({ sort: s.key }),
  }));
  // "" is the every-GC option. `accountId: null` is what the query parser
  // produces for it, so the two round-trip.
  const gcChoices: NavChoice[] = [
    { value: "", label: "Every GC", href: to({ accountId: null }) },
    ...gcOptions.map((g) => ({ value: g.id, label: g.name, href: to({ accountId: g.id }) })),
  ];

  const isFiltered =
    q.period !== "all" || q.kind !== "all" || q.overdueOnly || !!q.accountId || q.sort !== "amount";
  const clearParams = new URLSearchParams(extraParams).toString();

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <NavSelect label="Billed" value={q.period} choices={periodChoices} ariaLabel="Filter by billing period" />
      <NavSelect label="Type" value={q.kind} choices={kindChoices} ariaLabel="Filter by receivable type" />
      {/* Only offered when there is a choice to make. One GC in the book means
          the picker can only ever restate what's already on screen. */}
      {gcOptions.length > 1 && (
        <NavSelect label="GC" value={q.accountId ?? ""} choices={gcChoices} ariaLabel="Filter by GC" />
      )}
      <Link
        href={to({ overdueOnly: !q.overdueOnly })}
        aria-pressed={q.overdueOnly}
        className={`inline-flex items-center px-3 rounded-lg text-[12.5px] font-semibold border transition-colors min-h-[44px] sm:min-h-[38px] touch-manipulation ${
          q.overdueOnly
            ? "bg-rose-600 text-white border-rose-700"
            : "bg-surface text-ppp-charcoal-600 border-ppp-charcoal-200 hover:bg-ppp-charcoal-50"
        }`}
      >
        Overdue only
      </Link>
      <NavSelect label="Sort" value={q.sort} choices={sortChoices} ariaLabel="Sort the list" />
      {isFiltered && (
        <Link
          href={`${basePath}${clearParams ? `?${clearParams}` : ""}`}
          className="text-[12px] font-semibold text-cc-brand-700 hover:underline inline-flex items-center min-h-[44px] sm:min-h-[38px] px-1"
        >
          Clear
        </Link>
      )}
    </div>
  );
}
