import "server-only";

import {
  listCommercialOpportunities,
  opportunityStatusLabel,
  opportunitySourceLabel,
  opportunityLossReasonLabel,
  type OpportunitiesListFilters,
  type CommercialOpportunity,
} from "./db";
import { listCurrentStatusEnteredAtByOpp } from "./status";
import { listPrimaryLeadByOpp } from "./assignments";
import { listLastNoteByOpp } from "./notes";
import { listOpenTaskStatsByOpp } from "./tasks";
import { listAttachmentCountByOpp } from "./attachments";
import { commercialDb } from "@/lib/commercial/db";

/**
 * CSV export of the global Opportunities pipeline.
 *
 * Mirrors what /commercial/opportunities renders: same filter shape,
 * same row signals enriched in (primary lead, last note, days in
 * status, file count) so a spreadsheet can answer the same questions
 * the UI does without flipping back to the app.
 *
 * RFC 4180 quoting + UTF-8 BOM so Excel opens correctly on Mac/PC.
 * Mirrors lib/commercial/accounts/export.ts so the patterns stay
 * consistent across the platform.
 */

const HEADERS = [
  "Title",
  "Account",
  "Status",
  "Bid low ($)",
  "Bid high ($)",
  "Probability %",
  "Source",
  "Proposal due",
  "Proposed start",
  "Proposed end",
  "Decided",
  "Loss reason",
  "Primary lead",
  "Open tasks",
  "Overdue tasks",
  "Last note (date)",
  "Days in status",
  "Files",
  "Created",
  "Updated",
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
  // is treated as a formula by Excel / LibreOffice / Sheets. An opp
  // titled "=cmd|'/c calc'!A1" would execute when the user opens the
  // CSV. Prefixing with a single quote neutralizes it: Excel renders
  // the literal text without firing the formula engine.
  const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${s.replace(/"/g, '""')}"`;
}

function isoDate(s: string | null | undefined): string {
  if (!s) return "";
  return s.slice(0, 10);
}

function centsToDollars(c: number | null | undefined): string {
  if (c === null || c === undefined) return "";
  // Plain dollar number with no $ symbol — Excel will format if needed.
  return (c / 100).toFixed(2);
}

function daysSinceIso(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  return String(Math.floor(ms / 86_400_000));
}

/** Extra filter knobs that don't live on `OpportunitiesListFilters` but
 *  are computed post-fetch on the page (stale, hot). The export route
 *  applies them the same way the UI does. */
export type OpportunitiesExportFilters = OpportunitiesListFilters & {
  sources?: string[];
  stale?: boolean;
  hot?: boolean;
};

export async function exportOpportunitiesCsv(
  opps: CommercialOpportunity[]
): Promise<string> {
  const sb = commercialDb();
  const ids = opps.map((o) => o.id);

  // Bulk-load the per-opp signals + a one-shot account name map. Same
  // parallel pattern as the global page so the export query budget
  // matches what the user just looked at.
  const accountIds = Array.from(new Set(opps.map((o) => o.account_id).filter(Boolean)));
  const [statusEntered, primaryLead, lastNote, taskStats, fileCounts, accountsRows] =
    await Promise.all([
      listCurrentStatusEnteredAtByOpp(ids),
      listPrimaryLeadByOpp(ids),
      listLastNoteByOpp(ids),
      listOpenTaskStatsByOpp(ids),
      listAttachmentCountByOpp(ids),
      accountIds.length === 0
        ? Promise.resolve({ data: [] as { id: string; company_name: string }[] })
        : sb
            .from("commercial_accounts")
            .select("id, company_name")
            .in("id", accountIds)
            // Don't print a deleted account's name in the CSV — opps on a
            // soft-deleted account would otherwise leak the stale label.
            .is("deleted_at", null),
    ]);

  const accountNameById = new Map<string, string>();
  for (const r of (accountsRows.data ?? []) as { id: string; company_name: string }[]) {
    accountNameById.set(r.id, r.company_name);
  }

  const rows: string[] = [];
  // UTF-8 BOM + header row.
  rows.push("﻿" + HEADERS.map(csvEscape).join(","));

  for (const o of opps) {
    const entered = statusEntered.get(o.id) ?? null;
    const lead = primaryLead.get(o.id) ?? null;
    const note = lastNote.get(o.id) ?? null;
    const tasks = taskStats.get(o.id) ?? null;
    const fileCount = fileCounts.get(o.id) ?? 0;
    const leadLabel = lead
      ? lead.user_full_name ?? lead.user_email
      : "";
    rows.push(
      [
        csvEscape(o.title),
        csvEscape(accountNameById.get(o.account_id) ?? ""),
        csvEscape(opportunityStatusLabel(o.status)),
        csvEscape(centsToDollars(o.bid_value_low_cents)),
        csvEscape(centsToDollars(o.bid_value_high_cents)),
        csvEscape(o.probability_pct ?? ""),
        csvEscape(o.source ? opportunitySourceLabel(o.source) : ""),
        csvEscape(isoDate(o.proposal_due_at)),
        csvEscape(isoDate(o.proposed_start_at)),
        csvEscape(isoDate(o.proposed_end_at)),
        csvEscape(isoDate(o.decided_at)),
        csvEscape(o.loss_reason ? opportunityLossReasonLabel(o.loss_reason) : ""),
        csvEscape(leadLabel),
        csvEscape(tasks?.open ?? 0),
        csvEscape(tasks?.overdue ?? 0),
        csvEscape(isoDate(note?.created_at)),
        csvEscape(daysSinceIso(entered)),
        csvEscape(fileCount),
        csvEscape(isoDate(o.created_at)),
        csvEscape(isoDate(o.updated_at)),
      ].join(",")
    );
  }
  return rows.join("\r\n");
}

/** Filename like "ppp-commercial-opportunities_status-estimating_n42_2026-06-19.csv".
 *  Carries filter tokens so the user can tell which view they exported. */
export function exportOpportunitiesFilename(
  filters: OpportunitiesExportFilters,
  totalCount: number
): string {
  const today = new Date().toISOString().slice(0, 10);
  const tokens: string[] = ["ppp-commercial-opportunities"];
  if (filters.status) tokens.push(`status-${filters.status}`);
  if (filters.accountId) tokens.push("account-scoped");
  if (filters.search) tokens.push("search");
  if (filters.stale) tokens.push("stale");
  if (filters.hot) tokens.push("hot");
  if (filters.sources && filters.sources.length > 0) {
    tokens.push(`sources-${filters.sources.slice(0, 3).join("-")}`);
  }
  tokens.push(`n${totalCount}`);
  tokens.push(today);
  return `${tokens.join("_")}.csv`;
}
