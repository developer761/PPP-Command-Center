import "server-only";

import { listCommercialAccounts, type AccountsListFilters, type CommercialAccount } from "./db";
import { listTagsForAccounts } from "./tags";
import { listAccountOverviews } from "./overview";
import { ACTIVITY_STALE_DAYS } from "./constants";
import { daysAgoEt } from "@/lib/date-et";

/** The list page's post-fetch quick-filter chips (stale / expiring / issue /
 *  tag). Not DB-level filters — they read the per-account overview + tags. */
export type AccountQuickFilters = {
  stale?: boolean;
  expiring?: boolean;
  issue?: boolean;
  tag?: string;
};

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
  const raw =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : JSON.stringify(value);
  // OWASP CSV-injection defense: a value starting with `= + - @ \t \r`
  // is treated as a formula by Excel / LibreOffice / Sheets. A company
  // named "=cmd|'/c calc'!A1" or notes pasted from Excel would otherwise
  // execute when the user opens the CSV. Prefixing with a single quote
  // neutralizes it — Excel renders literal text without firing the
  // formula engine. Mirrors the same fix in opportunities/export.ts.
  const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${s.replace(/"/g, '""')}"`;
}

function isoDate(s: string | null | undefined): string {
  if (!s) return "";
  // Full timestamps → the ET calendar date (a bare UTC slice was a day off for
  // evening-ET records). Already-bare dates pass through unchanged.
  return s.includes("T") ? new Date(s).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) : s.slice(0, 10);
}

export async function exportAccountsCsv(
  filters: AccountsListFilters = {},
  quick: AccountQuickFilters = {}
): Promise<{ csv: string; count: number }> {
  const allAccounts = await listCommercialAccounts(filters);
  const ids = allAccounts.map((a) => a.id);
  const [tagsByAccount, overviewsById] = await Promise.all([
    listTagsForAccounts(ids),
    listAccountOverviews(ids),
  ]);

  // Apply the SAME post-fetch quick-filter chips the list page does (they read
  // overview + tags, not the DB query), so the CSV matches the VISIBLE set. The
  // export honored only rating/compliance/search — 3 of the 7 filters — so a
  // "Stale" or "Compliance issue" or tag view exported the wider book (audit
  // D10). Predicates mirror app/commercial/accounts/page.tsx exactly.
  const tagLower = quick.tag?.trim().toLowerCase();
  const accounts = allAccounts.filter((a) => {
    const ov = overviewsById.get(a.id) ?? null;
    if (quick.stale) {
      const days = daysAgoEt(ov?.last_activity_at) ?? 0;
      if (!(Number.isFinite(days) && days > ACTIVITY_STALE_DAYS)) return false;
    }
    if (quick.expiring) {
      if (!ov || ov.expired_document_count + ov.expiring_soon_document_count <= 0) return false;
    }
    if (quick.issue) {
      const hasIssue = a.vendor_compliance_status === "red" || (ov ? ov.expired_document_count > 0 : false);
      if (!hasIssue) return false;
    }
    if (tagLower) {
      const tags = tagsByAccount.get(a.id) ?? [];
      if (!tags.some((t) => t.tag.toLowerCase() === tagLower)) return false;
    }
    return true;
  });

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
  return { csv: rows.join("\r\n"), count: accounts.length };
}

/** Filename like "ppp-commercial-accounts-2026-06-18.csv" — drop tokens
 *  for any active filters so the user can tell "this is the export of
 *  the rating=A view." */
export function exportAccountsFilename(
  filters: AccountsListFilters,
  totalCount: number
): string {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const tokens: string[] = ["ppp-commercial-accounts"];
  if (filters.rating) tokens.push(`rating-${filters.rating}`);
  if (filters.compliance) tokens.push(`compliance-${filters.compliance}`);
  if (filters.search) tokens.push("search");
  tokens.push(`n${totalCount}`);
  tokens.push(today);
  return `${tokens.join("_")}.csv`;
}

// Re-export so callers needing the type don't have to wire two imports.
export type { CommercialAccount };
