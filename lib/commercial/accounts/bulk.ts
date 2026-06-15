import "server-only";

import { addAccountTag, MAX_TAG_LENGTH, normalizeTag } from "./tags";
import {
  addAssignment,
  type AssignmentRole,
} from "./assignments";

/**
 * Bulk operations on the Accounts list — multi-select then apply.
 * Used by the Accounts page when Alex wants to tag "these 12 healthcare
 * accounts" or "assign Sarah as PM on this whole batch" in one click.
 *
 * Each helper is best-effort: if any single account fails (e.g., already
 * tagged, account deleted between page-load and submit), we record the
 * failure and continue. The caller can surface "10 of 12 succeeded, 2
 * failed: ..." instead of all-or-nothing.
 *
 * Hard cap on batch size so a runaway request can't lock the DB. 200 is
 * comfortably more than Alex would ever click through, and well under
 * any realistic Postgres concurrent-write throttle.
 */

export const BULK_MAX_ACCOUNTS = 200;

export type BulkResult = {
  total: number;
  succeeded: number;
  failed: number;
  errors: Array<{ account_id: string; message: string }>;
};

/** Tag every account in `accountIds` with the same (normalized) tag.
 *  Skips accounts where the tag is already attached (idempotent). */
export async function bulkTagAccounts(
  accountIds: string[],
  rawTag: string,
  actingUserId?: string | null
): Promise<BulkResult> {
  const tag = normalizeTag(rawTag);
  const out: BulkResult = { total: accountIds.length, succeeded: 0, failed: 0, errors: [] };
  if (tag.length === 0) {
    return {
      ...out,
      failed: accountIds.length,
      errors: accountIds.map((id) => ({ account_id: id, message: "Tag can't be empty." })),
    };
  }
  if (tag.length > MAX_TAG_LENGTH) {
    return {
      ...out,
      failed: accountIds.length,
      errors: accountIds.map((id) => ({
        account_id: id,
        message: `Tag too long (max ${MAX_TAG_LENGTH} chars).`,
      })),
    };
  }
  if (accountIds.length > BULK_MAX_ACCOUNTS) {
    return {
      ...out,
      total: accountIds.length,
      failed: accountIds.length,
      errors: [
        {
          account_id: "",
          message: `Too many accounts in one batch (max ${BULK_MAX_ACCOUNTS}).`,
        },
      ],
    };
  }

  for (const accountId of accountIds) {
    const result = await addAccountTag(accountId, tag, actingUserId);
    if (result.ok) {
      out.succeeded += 1;
    } else {
      // "already tagged" is a friendly no-op — count it as success so
      // the user doesn't get a failure summary when the tag already
      // exists on some of the selected accounts.
      if (result.error.toLowerCase().includes("already tagged")) {
        out.succeeded += 1;
      } else {
        out.failed += 1;
        out.errors.push({ account_id: accountId, message: result.error });
      }
    }
  }
  return out;
}

/** Assign one PPP staffer in one role across every selected account.
 *  is_primary is intentionally NOT bulk-applied — you can't have ten
 *  accounts share a primary PM in one click without thought. The bulk
 *  form should hide the primary checkbox; this helper enforces it. */
export async function bulkAssignAccounts(
  accountIds: string[],
  input: { user_id: string; role: AssignmentRole; notes?: string | null },
  actingUserId?: string | null
): Promise<BulkResult> {
  const out: BulkResult = { total: accountIds.length, succeeded: 0, failed: 0, errors: [] };
  if (!input.user_id) {
    return {
      ...out,
      failed: accountIds.length,
      errors: accountIds.map((id) => ({ account_id: id, message: "Pick a PPP staff member." })),
    };
  }
  if (accountIds.length > BULK_MAX_ACCOUNTS) {
    return {
      ...out,
      total: accountIds.length,
      failed: accountIds.length,
      errors: [
        {
          account_id: "",
          message: `Too many accounts in one batch (max ${BULK_MAX_ACCOUNTS}).`,
        },
      ],
    };
  }

  for (const accountId of accountIds) {
    const result = await addAssignment({
      account_id: accountId,
      user_id: input.user_id,
      role: input.role,
      is_primary: false,
      notes: input.notes ?? null,
      assigned_by_user_id: actingUserId ?? null,
    });
    if (result.ok) {
      out.succeeded += 1;
    } else {
      // Idempotent: "already assigned in that role" counts as success.
      if (result.error.toLowerCase().includes("already assigned")) {
        out.succeeded += 1;
      } else {
        out.failed += 1;
        out.errors.push({ account_id: accountId, message: result.error });
      }
    }
  }
  return out;
}

// Note: per-row audit logging is handled inside addAccountTag /
// addAssignment, so the bulk helpers don't need additional logUpdate
// calls — every successful row leaves a trail like any single-row write.
