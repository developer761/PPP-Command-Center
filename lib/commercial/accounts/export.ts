import "server-only";

import { listCommercialAccounts, type AccountsListFilters, type CommercialAccount } from "./db";
import { listTagsForAccounts } from "./tags";
import { listAccountOverviews } from "./overview";

/**
 * CSV export of the Accounts list.
 *
 * Mirrors what the list page renders: filters apply, sort applies in
 * the same direction as the UI, tag + overview columns join in so a
 * spreadsheet has the same "5 contacts · 3 on team" snippet a
 * person sees on the page.
 *
 * RFC 4180 quoting: every value wrapped in double quotes, inner double
 * quotes doubled. Newlines in notes get preserved inside the quote.
 * BOM prepended so Excel on Mac/PC opens UTF-8 correctly without the
 * "smart quotes turn into mojibake" tax.
 */

const HEADERS = [
  "Company name",
  "DBA",
  "Industry",
  "Rating",
  "Compliance status",
  "Prequalification",
  "Billing city",
  "Billing state",
  "Billing ZIP",
  "Site city",
  "Site state",
  "Phone",
  "AP phone",
  "Website",
  "Tax exempt",
  "Tags",
  "Contacts",
  "PPP team",
  "Active docs",
  "Expired docs",
  "Expiring-soon docs",
  "Last activity",
  "Notes",
  "Created",
] as const;

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "\"\"";
  const s =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : JSON.stringify(value);
  // Double the inner quotes; wrap the whole value.
  return `"${s.replace(/"/g, '""')}"`;
}

function isoDate(s: string | null | undefined): string {
  if (!s) return "";
  // Slice to YYYY-MM-DD for the CSV — full timestamps are noisy and
  // Excel doesn't render TZ-suffixed strings as dates anyway.
  return s.slice(0, 10);
}

export async function exportAccountsCsv(filters: AccountsListFilters = {}): Promise<string> {
  const accounts = await listCommercialAccounts(filters);
  const ids = accounts.map((a) => a.id);
  const [tagsByAccount, overviewsById] = await Promise.all([
    listTagsForAccounts(ids),
    listAccountOverviews(ids),
  ]);

  const rows: string[] = [];
  // UTF-8 BOM so Excel opens it as UTF-8 (without it, Cyrillic / em-dash
  // / accented chars get mangled). Tiny size cost, big interop win.
  rows.push("﻿" + HEADERS.map(csvEscape).join(","));

  for (const a of accounts) {
    const tags = tagsByAccount.get(a.id) ?? [];
    const ov = overviewsById.get(a.id) ?? null;
    rows.push(
      [
        csvEscape(a.company_name),
        csvEscape(a.dba),
        csvEscape(a.industry),
        csvEscape(a.rating),
        csvEscape(a.vendor_compliance_status),
        csvEscape(a.prequalification_status),
        csvEscape(a.billing_city),
        csvEscape(a.billing_state),
        csvEscape(a.billing_zip),
        csvEscape(a.site_city),
        csvEscape(a.site_state),
        csvEscape(a.phone),
        csvEscape(a.ap_phone),
        csvEscape(a.website),
        csvEscape(a.tax_exempt ? "yes" : "no"),
        csvEscape(tags.map((t) => t.tag).join("; ")),
        csvEscape(ov?.contact_count ?? 0),
        csvEscape(ov?.ppp_team_count ?? 0),
        csvEscape(ov?.active_document_count ?? 0),
        csvEscape(ov?.expired_document_count ?? 0),
        csvEscape(ov?.expiring_soon_document_count ?? 0),
        csvEscape(isoDate(ov?.last_activity_at)),
        csvEscape(a.notes),
        csvEscape(isoDate(a.created_at)),
      ].join(",")
    );
  }
  return rows.join("\r\n");
}

/** Filename like "ppp-commercial-accounts-2026-06-18.csv" — drop tokens
 *  for any active filters so the user can tell "this is the export of
 *  the rating=A view." */
export function exportAccountsFilename(
  filters: AccountsListFilters,
  totalCount: number
): string {
  const today = new Date().toISOString().slice(0, 10);
  const tokens: string[] = ["ppp-commercial-accounts"];
  if (filters.rating) tokens.push(`rating-${filters.rating}`);
  if (filters.compliance) tokens.push(`compliance-${filters.compliance}`);
  if (filters.industry) tokens.push(`industry-${filters.industry.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
  if (filters.search) tokens.push("search");
  tokens.push(`n${totalCount}`);
  tokens.push(today);
  return `${tokens.join("_")}.csv`;
}

// Re-export so callers needing the type don't have to wire two imports.
export type { CommercialAccount };
