/**
 * Submittals — cross-project index (sidebar tab). Projects grouped by account
 * with each one's latest submittal status; tap to open that project's
 * submittals. Consistent with the Change Orders / AIA / Closeout tabs.
 */
import { redirect } from "next/navigation";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { SubmittalsGroupedIndex } from "./index-grouped";

export const dynamic = "force-dynamic";

export default async function SubmittalsIndexPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  return <SubmittalsGroupedIndex />;
}
