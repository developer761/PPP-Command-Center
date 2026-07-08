/**
 * `/commercial/invoices/new?opp=<uuid>` — retired 2026-07-07.
 *
 * Karan called the batch creator page a jumping problem: user clicks
 * "New invoice" and gets teleported to a full-page form instead of
 * being able to work inline. Solution: create is now an inline
 * <details> collapsible on the account-filtered detail view (see
 * `FullDetailByOpp` in `/commercial/invoices/page.tsx`).
 *
 * This route stays as a compatibility shim — any legacy link, bell
 * notification, or bookmark that still points at `/new?opp=<uuid>`
 * redirects to `/commercial/invoices?account_id=<X>#opp-<Y>` and
 * the user lands on the same surface where the inline form lives.
 * Invalid opp_id (missing/malformed/not-Won/deleted) falls back to
 * the unfiltered invoices list with an error toast.
 */
import { redirect } from "next/navigation";
import { getCommercialOpportunity } from "@/lib/commercial/opportunities/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import { pickFirst } from "@/lib/commercial/form-utils";

export const dynamic = "force-dynamic";

type SP = Promise<{ opp?: string }>;

export default async function NewInvoiceRedirect({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const opp_id = pickFirst(sp.opp);
  if (!opp_id || !UUID_RE.test(opp_id)) {
    redirect("/commercial/invoices?status_error=" + encodeURIComponent("Pick an opportunity first"));
  }
  const opp = await getCommercialOpportunity(opp_id!);
  if (!opp) {
    redirect("/commercial/invoices?status_error=" + encodeURIComponent("Opportunity not found"));
  }
  if (opp!.status !== "won") {
    redirect(
      `/commercial/opportunities/${opp!.id}?tab=info&error=` +
        encodeURIComponent("Only Won opportunities can be invoiced")
    );
  }
  redirect(`/commercial/invoices?account_id=${opp!.account_id}#add-${opp!.id}`);
}
