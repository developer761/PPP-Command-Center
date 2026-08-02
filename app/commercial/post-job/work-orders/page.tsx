/**
 * Work Orders — cross-project index (sidebar tab). Projects grouped by account
 * with each one's Work Order status (not created / draft / sent to crew); tap to
 * open that project's Work Order. Consistent with the other Post-Contract tabs.
 */
import { redirect } from "next/navigation";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { WorkOrdersGroupedIndex } from "./index-grouped";

export const dynamic = "force-dynamic";

export default async function WorkOrdersIndexPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  return <WorkOrdersGroupedIndex />;
}
