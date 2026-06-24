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

    // Active docs with expires_at in the warning window OR already
    // expired (within the last year). Past-expiry docs still nag
    // (capped by the 30-day dedup) because that's when the AM most
    // needs the prod to chase a renewal. The bell/email copy renders
    // "Expired N days ago" so the assignee knows the difference.
    //
    // Lower bound `expires_at >= now - 1 year` prevents a flood when
    // the cron first ships: without it, a stale COI uploaded in 2023
    // and never refreshed would fire its first-ever reminder on
    // launch day, then every 30 days thereafter. 1 year covers the
    // longest realistic renewal cycle on PPP's compliance docs (COIs
    // renew yearly; W9s less often but those are caught by a
    // different mental model). Anything older is dead-archive doc
    // hygiene, not a Stage-1 cron concern.
    const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    const { data, error } = await sb
      .from("commercial_account_documents")
      .select(
        `id, file_name, category, expires_at, account_id,
         account:commercial_accounts!inner(id, company_name, deleted_at)`
      )
      .eq("archived", false)
      .not("expires_at", "is", null)
      .gte("expires_at", oneYearAgo.toISOString())
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
    // an N+1 against the assignments table. Join profiles + filter for
    // is_active=true so an inactive primary never becomes the chosen
    // recipient (audit fix: previously the doc dead-lettered to an
    // inactive AM and never fell through to a live teammate).
    const accountIds = Array.from(new Set(rows.map((r) => r.account_id)));
    const { data: assignments } = await sb
      .from("commercial_account_assignments")
      .select(
        "account_id, user_id, role, user:profiles!commercial_account_assignments_user_id_fkey(is_active, has_new_platform_access)"
      )
      .in("account_id", accountIds)
      .eq("is_primary", true)
      .is("removed_at", null);
    type Assn = {
      account_id: string;
      user_id: string;
      role: string;
      user:
        | { is_active: boolean | null; has_new_platform_access: boolean | null }
        | Array<{ is_active: boolean | null; has_new_platform_access: boolean | null }>
        | null;
    };
    const byAccount = new Map<string, Array<{ user_id: string; role: string }>>();
    for (const a of (assignments ?? []) as unknown as Assn[]) {
      const u = Array.isArray(a.user) ? a.user[0] ?? null : a.user;
      if (u?.is_active === false) continue; // skip deactivated primaries
      // Audit fix 2026-06-24: skip if Commercial CC access was revoked
      // post-assignment — they can't act on the doc anymore.
      if (u?.has_new_platform_access === false) continue;
      const list = byAccount.get(a.account_id) ?? [];
      list.push({ user_id: a.user_id, role: a.role });
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
        // 29 days, not 30: dedup cutoff at exactly 30d would still match
        // a row created at the previous fire. Trimming 1 day gives a
        // safety margin so the monthly reminder actually releases.
        // (Audit fix 2026-06-18.)
        const recent = await hasRecentNotification(
          "commercial_document_expiring",
          r.id,
          (WARN_WINDOW_DAYS - 1) * 24
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
