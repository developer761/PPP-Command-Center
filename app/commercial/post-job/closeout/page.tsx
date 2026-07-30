/**
 * Closeout & Warranty — cross-project index (sidebar tab). Projects grouped by
 * account with each one's latest close-out status; tap to open that project's
 * closeout. Consistent with the Change Orders + AIA Billing tabs.
 */
import { redirect } from "next/navigation";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { CloseoutGroupedIndex } from "./index-grouped";

export const dynamic = "force-dynamic";

export default async function CloseoutIndexPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  return <CloseoutGroupedIndex />;
}
