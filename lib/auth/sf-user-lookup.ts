import "server-only";

import { getSalesforceClient } from "@/lib/salesforce/client";
import { crossDomainEmailVariant, normalizeEmail } from "@/lib/auth/admin";

/**
 * Look up a Salesforce User by email, with cross-domain fallback.
 *
 * PPP uses both `@precisionpaintingplus.net` and `@precisionpaintingplus.com`.
 * A staff member might sign in via Google as `kate@ppp.net` but have
 * `kate@ppp.com` recorded as their SF User.Email — or vice versa. Lookup
 * tries the original email first, then the swapped-domain variant.
 *
 * Returns null if no match in EITHER domain.
 *
 * If multiple SF Users match (Mike Adler vs Mike Adler WP, etc.), we prefer
 * active records, then most recent CreatedDate.
 */

export type SfUserLookupResult = {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
};

type SfUserRow = {
  Id: string;
  Name: string | null;
  Email: string | null;
  IsActive: boolean;
  CreatedDate: string;
};

export async function lookupSfUserByEmail(
  email: string
): Promise<SfUserLookupResult | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  let match = await queryByEmail(normalized);

  // Fallback: try the cross-domain variant if no match on the original
  if (!match) {
    const swapped = crossDomainEmailVariant(normalized);
    if (swapped && swapped !== normalized) {
      match = await queryByEmail(swapped);
    }
  }

  return match;
}

async function queryByEmail(email: string): Promise<SfUserLookupResult | null> {
  try {
    const conn = await getSalesforceClient();
    // Escape single quotes in email for SOQL safety
    const safe = email.replace(/'/g, "\\'");
    const result = await conn.query<SfUserRow>(
      `SELECT Id, Name, Email, IsActive, CreatedDate FROM User WHERE Email = '${safe}' ORDER BY IsActive DESC, CreatedDate DESC LIMIT 5`
    );
    const records = result.records;
    if (records.length === 0) return null;
    const best = records[0]; // already sorted by IsActive DESC, CreatedDate DESC
    return {
      id: best.Id,
      name: best.Name ?? "",
      email: best.Email ?? email,
      isActive: best.IsActive,
    };
  } catch (err) {
    // SF unreachable or query rejected — don't block sign-in, return null.
    console.error("[auth] SF user lookup failed:", err);
    return null;
  }
}
