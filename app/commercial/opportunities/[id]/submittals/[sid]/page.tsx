/**
 * Compatibility shim — the submittal detail page moved to the account-scoped
 * route (/commercial/accounts/[id]/submittals/[dealId]/[sid]) so Submittals no
 * longer hangs off the opportunity page. Any legacy link / bookmark to the old
 * URL resolves the opportunity's account and forwards to the new home.
 */
import { redirect, notFound } from "next/navigation";
import { getCommercialOpportunity } from "@/lib/commercial/opportunities/db";
import { UUID_RE } from "@/lib/commercial/uuid";

type PP = Promise<{ id: string; sid: string }>;

export default async function LegacySubmittalDetailRedirect({ params }: { params: PP }) {
  const { id: opportunity_id, sid: submittal_id } = await params;
  if (!UUID_RE.test(opportunity_id) || !UUID_RE.test(submittal_id)) notFound();
  const opp = await getCommercialOpportunity(opportunity_id);
  if (!opp?.account_id) redirect("/commercial/post-job/submittals");
  redirect(`/commercial/accounts/${opp.account_id}/submittals/${opportunity_id}/${submittal_id}`);
}
