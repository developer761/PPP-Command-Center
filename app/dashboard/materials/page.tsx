import { loadDashboardData } from "@/lib/data-source";
import MaterialsView from "@/components/materials-view";
import { deriveOpenMaterialsWorkOrders } from "@/lib/salesforce/materials";
import { getFormStatusByWO, type FormStatus } from "@/lib/customer-form/wo-status";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function MaterialsOrderingPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const bundle = await loadDashboardData(sp);

  // Wire customer-form status into the page so each WO card can show
  // "Submitted / Opened / Sent / —". One Supabase query for ALL visible WOs
  // (Supabase IN-clause is fast at this scale, ~570 max). Falls back to an
  // empty map on any error so the page still renders if Supabase is down.
  const openJobs = bundle.snapshot ? deriveOpenMaterialsWorkOrders(bundle.snapshot) : [];
  const woIds = openJobs.map((j) => j.wo.id);
  let formStatusByWO: Map<string, FormStatus>;
  try {
    formStatusByWO = await getFormStatusByWO(woIds);
  } catch (err) {
    console.error("[materials] form-status load failed:", err);
    formStatusByWO = new Map();
  }
  // Serialize Map → array for client-component prop (Maps don't serialize
  // across the server/client boundary in Next).
  const formStatuses = Array.from(formStatusByWO.values());

  return <MaterialsView bundle={bundle} formStatuses={formStatuses} />;
}
