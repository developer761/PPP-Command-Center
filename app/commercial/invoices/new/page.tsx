/**
 * `/commercial/invoices/new?opp=<uuid>` — one-click convert from a Won
 * opportunity to a new draft invoice.
 *
 * Server-only route: creates the invoice, then redirects to the
 * detail page. The user never lands on this page URL for more than a
 * blink; they see the newly-created invoice detail instead.
 */
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createCommercialInvoice } from "@/lib/commercial/invoices/db";
import { getCommercialOpportunity } from "@/lib/commercial/opportunities/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import { pickFirst } from "@/lib/commercial/form-utils";

export const dynamic = "force-dynamic";

type SP = Promise<{ opp?: string }>;

export default async function NewInvoiceRoute({ searchParams }: { searchParams: SP }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const sp = await searchParams;
  const opp_id = pickFirst(sp.opp);
  if (!opp_id || !UUID_RE.test(opp_id)) {
    redirect("/commercial/opportunities?status_error=" + encodeURIComponent("Pick an opportunity first"));
  }

  const opp = await getCommercialOpportunity(opp_id!);
  if (!opp) redirect("/commercial/opportunities?status_error=" + encodeURIComponent("Opportunity not found"));
  if (opp.status !== "won") {
    redirect(`/commercial/opportunities/${opp!.id}?tab=info&error=` + encodeURIComponent("Only Won opportunities can be invoiced"));
  }

  const result = await createCommercialInvoice({
    opportunity_id: opp!.id,
    account_id: opp!.account_id,
    created_by_user_id: user.id,
  });
  if (!result.ok) {
    redirect(`/commercial/opportunities/${opp!.id}?tab=info&error=` + encodeURIComponent(result.error));
  }
  redirect(`/commercial/invoices/${result.invoice.id}`);
}
