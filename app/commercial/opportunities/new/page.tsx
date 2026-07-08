/**
 * `/commercial/opportunities/new` — retired 2026-07-08.
 *
 * Karan's accounts+opps merge: deal creation is now an inline
 * <details> collapsible on the Account Pipeline tab (see
 * `NewDealForm` in `/commercial/accounts/[id]/page.tsx`). This route
 * is a compatibility shim that redirects legacy links + bookmarks
 * + bell notifications to the account-scoped inline form.
 *
 * URL shapes handled:
 *   - `?account=<uuid>` (from Account 360 CTA) → redirects to
 *     `/commercial/accounts/<uuid>?tab=opportunities&new_deal=1`
 *     which auto-opens the collapsible.
 *   - No account → redirects to `/commercial/accounts` where the user
 *     picks a customer first, then the "+ New deal" collapsible on the
 *     Pipeline tab.
 *
 * No form, no jump — you land where the deal actually lives, with the
 * form already open.
 */
import { redirect } from "next/navigation";
import { UUID_RE } from "@/lib/commercial/uuid";
import { pickFirst } from "@/lib/commercial/form-utils";

export const dynamic = "force-dynamic";

type SP = Promise<{ account?: string; error?: string }>;

export default async function NewOpportunityRedirect({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const account = pickFirst(sp.account);
  const error = pickFirst(sp.error);
  if (account && UUID_RE.test(account)) {
    const q = new URLSearchParams({ tab: "opportunities", new_deal: "1" });
    if (error) q.set("error", error);
    redirect(`/commercial/accounts/${account}?${q.toString()}#new-deal`);
  }
  // No account context → send them to the accounts list. Users pick
  // the customer first, then hit the inline "+ New deal" collapsible
  // on the Pipeline sub-tab. The status_error param renders as a
  // rose banner on the accounts list.
  redirect(
    "/commercial/accounts?status_error=" +
      encodeURIComponent("Pick the customer first — deals live under their account.")
  );
}
