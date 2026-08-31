import "server-only";

import { getSalesforceClient } from "@/lib/salesforce/client";
import { crossDomainEmailVariant, normalizeEmail } from "@/lib/auth/admin";

/**
 * Look up a Salesforce User by email, across BOTH PPP domains at once.
 *
 * PPP uses `@precisionpaintingplus.net` and `@precisionpaintingplus.com`, and
 * plenty of staff exist on both — usually one live record and one leftover.
 *
 * KATE, 2026-08-31. Amy Mariani could not sign in: her ACTIVE user is on .com
 * and an INACTIVE one on .net. The old lookup queried the signed-in address
 * first and stopped as soon as that query returned anything at all, active or
 * not. So the dead .net record won, the cross-domain fallback never ran, and
 * the hub told a current employee her Salesforce user was inactive.
 *
 * The domain is therefore not a tiebreak — both are searched, every candidate
 * is pooled, and an ACTIVE user wins regardless of which domain it sits on.
 * Only when NO active user exists on either domain is the person turned away,
 * and then the message says exactly that.
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

  const swapped = crossDomainEmailVariant(normalized);
  const addresses = swapped && swapped !== normalized ? [normalized, swapped] : [normalized];

  // Both domains, together. Querying them in sequence and keeping the first
  // answer is what shadowed an active user behind a dead one.
  const found = (await Promise.all(addresses.map(queryCandidates))).flat();
  return pickBestUser(found);
}

/**
 * The one record that should decide whether this person gets in.
 *
 * ACTIVE beats inactive, always and across domains — that is the whole fix.
 * Among equals, the most recently created wins, which is the right tiebreak
 * for duplicates like "Mike Adler" and "Mike Adler WP".
 *
 * Pure, so the ranking can be tested without Salesforce — the ordering is the
 * part that was wrong, not the query.
 */
export function pickBestUser(candidates: SfUserCandidate[]): SfUserLookupResult | null {
  if (candidates.length === 0) return null;
  const ranked = [...candidates].sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return (b.createdDate ?? "").localeCompare(a.createdDate ?? "");
  });
  const best = ranked[0];
  return { id: best.id, name: best.name, email: best.email, isActive: best.isActive };
}

export type SfUserCandidate = {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  createdDate: string | null;
};

async function queryCandidates(email: string): Promise<SfUserCandidate[]> {
  try {
    // Reject anything that isn't a structurally plausible email up-front.
    // RFC 5321 forbids most special chars, but better to be explicit: only
    // allow letters, digits, dot, underscore, plus, hyphen, and a single @.
    // This eliminates the SOQL-injection surface entirely (no quotes, no
    // backslashes, no semicolons can reach the query).
    if (!/^[a-z0-9._+\-]+@[a-z0-9.\-]+$/i.test(email)) {
      return [];
    }
    const conn = await getSalesforceClient();
    // Belt-and-suspenders: also escape backslash and single quote so jsforce
    // can't surprise us if the regex is ever loosened.
    const safe = email.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const result = await conn.query<SfUserRow>(
      `SELECT Id, Name, Email, IsActive, CreatedDate FROM User WHERE Email = '${safe}' ORDER BY IsActive DESC, CreatedDate DESC LIMIT 5`
    );
    // Every match, not just this domain's best — the caller ranks across both.
    return result.records.map((r) => ({
      id: r.Id,
      name: r.Name ?? "",
      email: r.Email ?? email,
      isActive: r.IsActive,
      createdDate: r.CreatedDate ?? null,
    }));
  } catch (err) {
    // SF unreachable or query rejected — don't block sign-in, return nothing.
    console.error("[auth] SF user lookup failed:", err);
    return [];
  }
}
