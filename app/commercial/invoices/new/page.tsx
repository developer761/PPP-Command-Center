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
import { isWon } from "@/lib/commercial/opportunities/constants";
import { UUID_RE } from "@/lib/commercial/uuid";
import { pickFirst } from "@/lib/commercial/form-utils";

export const dynamic = "force-dynamic";

type SP = Promise<{ opp?: string }>;

export default async function NewInvoiceRedirect({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const opp_id = pickFirst(sp.opp);
  if (!opp_id || !UUID_RE.test(opp_id)) {
    redirect("/commercial/invoices?status_error=" + encodeURIComponent("Pick a deal first"));
  }
  const opp = await getCommercialOpportunity(opp_id!);
  if (!opp) {
    redirect("/commercial/invoices?status_error=" + encodeURIComponent("Deal not found"));
  }
  // v2: "Won" is (pre_sale_closed, won). We also allow Post-Sale statuses
  // (Coordination/Ready to Mobilize/etc.) — a project already in delivery
  // can absolutely be invoiced. The gate is really "past the Won line."
  if (!isWon(opp!) && opp!.status !== "pre_construction" && opp!.status !== "in_progress" && opp!.status !== "billing" && opp!.status !== "post_sale_closed") {
    // Karan 2026-07-07: stay on the invoicing surface. Sending the user
    // to the opp detail page would be a jump; the "no jumping" mandate
    // says every invoice-adjacent error should land back on the invoice
    // list where they can pick a different opp.
    redirect(
      `/commercial/invoices?error=` +
        encodeURIComponent("Only Won deals can be invoiced")
    );
  }
  // Karan 2026-07-07: use ?add=<opp_id> query param (NOT hash) so the
  // server component can auto-open the inline "+ New invoice"
  // collapsible for that opp. `<details>` elements don't respond to
  // URL hash fragments; the query param is the only way to server-
  // render `open={true}`. The #opp-<id> hash is still there for the
  // browser's built-in scroll-into-view.
  redirect(`/commercial/invoices?account_id=${opp!.account_id}&add=${opp!.id}#opp-${opp!.id}`);
}
