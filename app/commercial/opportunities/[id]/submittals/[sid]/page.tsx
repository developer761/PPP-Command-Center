/**
 * Deep link to one submittal.
 *
 * This route has now pointed both ways. It first forwarded to the
 * account-scoped detail page, when Submittals hung off the account; restructure
 * step 3 (Karan 2026-08-12) moved the tools onto the opportunity, which left
 * this shim redirecting to a route that redirects straight back here.
 *
 * It resolves in one hop again: the submittals tool renders the detail in place
 * when handed `&sid=`, so this lands on the deal's own page with that submittal
 * open — no account lookup, no second redirect.
 */
import { redirect, notFound } from "next/navigation";
import { UUID_RE } from "@/lib/commercial/uuid";

type PP = Promise<{ id: string; sid: string }>;

export default async function SubmittalDeepLink({ params }: { params: PP }) {
  const { id: opportunity_id, sid: submittal_id } = await params;
  if (!UUID_RE.test(opportunity_id) || !UUID_RE.test(submittal_id)) notFound();
  redirect(
    `/commercial/opportunities/${opportunity_id}?tab=project&sub=submittals&sid=${submittal_id}`
  );
}
