import { ACTIVITY_PRESETS, ACTIVITY_DEFAULT, activityRange, resolvePreset, type ActivityPreset } from "./presets";
import type { ReceivableFilters, ReceivableKind } from "./receivables";

/**
 * ONE reader for the receivables filter query-string.
 *
 * The page, the CSV export and the Accounting view all take the same params.
 * If each parsed them itself, "Export" would eventually download a different
 * slice than the screen — invisible in a spreadsheet, and the whole reason the
 * date presets were centralised.
 */

export type ReceivableQuery = {
  period: ActivityPreset;
  kind: ReceivableKind | "all";
  overdueOnly: boolean;
  accountId: string | null;
  sort: "amount" | "oldest";
};

const KINDS: ReceivableKind[] = ["invoice", "aia", "retainage"];

/** Accepts Next's searchParams shape or URLSearchParams-style getters. */
export function parseReceivableQuery(
  get: (k: string) => string | string[] | undefined | null
): ReceivableQuery {
  const one = (k: string): string | undefined => {
    const v = get(k);
    return (Array.isArray(v) ? v[0] : v) ?? undefined;
  };
  const rawKind = one("kind");
  return {
    period: resolvePreset(one("period"), ACTIVITY_PRESETS, ACTIVITY_DEFAULT),
    kind: KINDS.includes(rawKind as ReceivableKind) ? (rawKind as ReceivableKind) : "all",
    overdueOnly: one("overdue") === "1",
    accountId: one("gc")?.trim() || null,
    sort: one("sort") === "oldest" ? "oldest" : "amount",
  };
}

/** The query as the report's filter object. */
export function filtersFor(q: ReceivableQuery): ReceivableFilters {
  const range = activityRange(q.period);
  return {
    fromYmd: range?.fromYmd,
    toYmd: range?.toYmd,
    kind: q.kind === "all" ? undefined : q.kind,
    overdueOnly: q.overdueOnly || undefined,
    accountId: q.accountId ?? undefined,
    sort: q.sort,
  };
}

/** The query back as a query-string, for links and the export URL. Omits
 *  defaults so a clean view has a clean URL. */
export function receivableQueryParams(q: ReceivableQuery): Record<string, string> {
  const out: Record<string, string> = {};
  if (q.period !== ACTIVITY_DEFAULT) out.period = q.period;
  if (q.kind !== "all") out.kind = q.kind;
  if (q.overdueOnly) out.overdue = "1";
  if (q.accountId) out.gc = q.accountId;
  if (q.sort !== "amount") out.sort = q.sort;
  return out;
}

/** `?a=b&c=d` (with leading `?`) or "" — for building hrefs. */
export function receivableQueryString(
  q: ReceivableQuery,
  extra: Record<string, string> = {}
): string {
  const qs = new URLSearchParams({ ...receivableQueryParams(q), ...extra });
  const s = qs.toString();
  return s ? `?${s}` : "";
}

/** Plain-English description of what is being shown, for the empty state and
 *  the export filename — so a filtered view never looks like an empty book. */
export function describeReceivableQuery(q: ReceivableQuery): string | null {
  const bits: string[] = [];
  const range = activityRange(q.period);
  if (range) bits.push(range.label.toLowerCase());
  if (q.kind !== "all") {
    bits.push(q.kind === "aia" ? "AIA only" : q.kind === "retainage" ? "retention only" : "invoices only");
  }
  if (q.overdueOnly) bits.push("overdue only");
  // Sort is not a filter — it changes order, not membership — so it is
  // deliberately absent from the "showing X of Y" description.
  return bits.length ? bits.join(" · ") : null;
}
