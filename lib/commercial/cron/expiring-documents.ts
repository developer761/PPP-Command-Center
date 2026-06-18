import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import {
  hasRecentNotification,
  insertCommercialDocumentExpiringNotification,
} from "@/lib/notifications/commercial-events";
import { documentCategoryLabel } from "@/lib/commercial/accounts/documents";

/**
 * Daily cron job — fire bell + email for active documents whose
 * expires_at is within 30 days. Dedupe window 30 days per document:
 * one reminder per expiring doc per warning cycle, no nag spam.
 *
 * Targets: documents with expires_at within next 30 days
 *          + archived = FALSE  (skip superseded versions)
 *          + parent account still alive
 *          + recipient = active primary account_manager on the account
 *
 * Recipient resolution priority:
 *   1. primary account_manager (role='account_manager', is_primary=true)
 *   2. ANY active primary on the account (other role)
 *   3. Skip — no one to notify, log and move on
 */

type Result = {
  ok: boolean;
  found: number;
  sent: number;
  skipped: number;
  errors: string[];
};

const WARN_WINDOW_DAYS = 30;

export async function runExpiringDocumentsReminder(): Promise<Result> {
  const out: Result = { ok: true, found: 0, sent: 0, skipped: 0, errors: [] };
  try {
    const sb = commercialDb();
    const now = new Date();
    const windowEnd = new Date(now.getTime() + WARN_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    // Active docs with expires_at in the warning window, joined to the
    // parent account so we can filter soft-deleted accounts in-query.
    // Include expires_at >= now so we don't pester about already-expired
    // docs every day — the document group view already surfaces those
    // as "expired" badges. This cron is about UPCOMING expiry.
    const { data, error } = await sb
      .from("commercial_account_documents")
      .select(
        `id, file_name, category, expires_at, account_id,
         account:commercial_accounts!inner(id, company_name, deleted_at)`
      )
      .eq("archived", false)
      .not("expires_at", "is", null)
      .gte("expires_at", now.toISOString())
      .lte("expires_at", windowEnd.toISOString())
      .is("account.deleted_at", null);
    if (error) {
      out.ok = false;
      out.errors.push(`document query failed: ${error.message}`);
      return out;
    }
    type Row = {
      id: string;
      file_name: string;
      category: string;
      expires_at: string;
      account_id: string;
      account:
        | { id: string; company_name: string; deleted_at: string | null }
        | Array<{ id: string; company_name: string; deleted_at: string | null }>
        | null;
    };
    const rows = (data ?? []) as unknown as Row[];
    out.found = rows.length;
    if (rows.length === 0) return out;

    // Bulk-resolve primary recipients per account_id so we don't fire
    // an N+1 against the assignments table. Pull every active primary
    // assignment for the set of accounts in one query, then pick the
    // best recipient per account.
    const accountIds = Array.from(new Set(rows.map((r) => r.account_id)));
    const { data: assignments } = await sb
      .from("commercial_account_assignments")
      .select("account_id, user_id, role")
      .in("account_id", accountIds)
      .eq("is_primary", true)
      .is("removed_at", null);
    type Assn = { account_id: string; user_id: string; role: string };
    const byAccount = new Map<string, Assn[]>();
    for (const a of (assignments ?? []) as Assn[]) {
      const list = byAccount.get(a.account_id) ?? [];
      list.push(a);
      byAccount.set(a.account_id, list);
    }

    for (const r of rows) {
      const acct = Array.isArray(r.account) ? r.account[0] ?? null : r.account;
      if (!acct) {
        out.skipped += 1;
        continue;
      }
      // Recipient priority: primary account_manager > any other primary.
      const candidates = byAccount.get(r.account_id) ?? [];
      const am = candidates.find((c) => c.role === "account_manager");
      const recipient = am ?? candidates[0] ?? null;
      if (!recipient) {
        out.skipped += 1;
        continue;
      }
      try {
        const recent = await hasRecentNotification(
          "commercial_document_expiring",
          r.id,
          WARN_WINDOW_DAYS * 24
        );
        if (recent) {
          out.skipped += 1;
          continue;
        }
        await insertCommercialDocumentExpiringNotification({
          documentId: r.id,
          accountId: r.account_id,
          accountName: acct.company_name,
          fileName: r.file_name,
          // Render the human-readable label ("Certificate of Insurance
          // (COI)") rather than the raw enum slug. Falls back to the raw
          // slug if a new category landed on disk before the lib's enum.
          category: isKnownCategory(r.category)
            ? documentCategoryLabel(r.category)
            : r.category,
          expiresAt: r.expires_at,
          recipientUserId: recipient.user_id,
        });
        out.sent += 1;
      } catch (err) {
        out.errors.push(
          `doc ${r.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return out;
  } catch (err) {
    out.ok = false;
    out.errors.push(err instanceof Error ? err.message : String(err));
    return out;
  }
}

const KNOWN_CATEGORIES = new Set([
  "coi",
  "w9",
  "master_agreement",
  "vendor_onboarding",
  "safety",
  "other",
]);

function isKnownCategory(
  c: string
): c is "coi" | "w9" | "master_agreement" | "vendor_onboarding" | "safety" | "other" {
  return KNOWN_CATEGORIES.has(c);
}
