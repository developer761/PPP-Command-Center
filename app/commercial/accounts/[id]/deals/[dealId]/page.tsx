/**
 * Nested deal URL: `/commercial/accounts/[id]/deals/[dealId]`.
 *
 * Karan 2026-07-08 Accounts+Deals merge: the deal semantically lives
 * UNDER the customer. This nested path is the canonical URL for a
 * deal going forward — every hierarchy-aware caller (breadcrumbs,
 * bell notifications targeting a new deal, future features) should
 * emit URLs in this shape.
 *
 * Implementation: for now this route redirects to the existing flat
 * `/commercial/opportunities/[id]` page (which handles all deal
 * detail rendering + server actions). Full move of the 4000-line
 * detail page to live at the nested path is deferred; the URL space
 * is what needs to be true right now so bookmarks, deep-links, and
 * shared URLs already read like "deal is under account."
 *
 * Guards:
 *   - Account UUID must be valid.
 *   - Deal UUID must be valid.
 *   - Deal must exist AND belong to the given account. A mismatched
 *     account/deal pair (e.g. someone hand-edited the URL, or the
 *     deal was moved to a different account) redirects to the account
 *     page with a rose banner instead of silently opening a deal
 *     that isn't actually under this customer.
 */
import { notFound, redirect } from "next/navigation";
import { getCommercialOpportunity } from "@/lib/commercial/opportunities/db";
import { UUID_RE } from "@/lib/commercial/uuid";

type PP = Promise<{ id: string; dealId: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;

export const dynamic = "force-dynamic";

export default async function NestedDealRedirect({
  params,
  searchParams,
}: {
  params: PP;
  searchParams: SP;
}) {
  const { id, dealId } = await params;
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId)) notFound();

  const opp = await getCommercialOpportunity(dealId);
  if (!opp) notFound();

  if (opp.account_id !== id) {
    // Mismatched pair — the deal exists but doesn't belong to the
    // customer in the URL. Send them to that deal's REAL account
    // (safer than a hard 404 — they land on legit data + can navigate
    // from there).
    redirect(
      `/commercial/accounts/${opp.account_id}?status_error=${encodeURIComponent(
        "That deal moved to a different customer — landed you on the right account."
      )}#deal-${dealId}`
    );
  }

  // Preserve every query param + hash so existing deep-links (?tab=info,
  // ?edited=1, etc.) work identically after the redirect.
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (Array.isArray(v)) v.forEach((val) => qs.append(k, val));
    else if (v != null) qs.set(k, v);
  }
  const qsStr = qs.toString();
  redirect(`/commercial/opportunities/${dealId}${qsStr ? `?${qsStr}` : ""}`);
}
