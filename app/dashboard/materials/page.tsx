import { loadDashboardData } from "@/lib/data-source";
import MaterialsView from "@/components/materials-view";
import { deriveOpenMaterialsWorkOrders } from "@/lib/salesforce/materials";
import { getMaterialsPageAuxData } from "@/lib/materials-page-data";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function MaterialsOrderingPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const bundle = await loadDashboardData(sp);

  // Speed: ONE consolidated Supabase load builds both the form-status
  // map + the progress timeline map from the same connection. Was two
  // separate loaders (getFormStatusByWO + getProgressByWO) that each
  // opened their own Supabase client and made redundant queries — ~300-
  // 600ms wasted per page load. Now: 2 Supabase queries total (1 to
  // customer_form_tokens, 1 to supplier_orders), run in parallel.
  const openJobs = bundle.snapshot ? deriveOpenMaterialsWorkOrders(bundle.snapshot) : [];
  const woIds = openJobs.map((j) => j.wo.id);

  const aux = await getMaterialsPageAuxData(woIds).catch((err) => {
    console.error("[materials] aux data load failed:", err);
    return { formStatusByWO: new Map(), progressByWO: new Map() };
  });

  // Serialize Maps → arrays for client-component props (Maps don't
  // serialize cleanly across the server/client boundary in Next).
  const formStatuses = Array.from(aux.formStatusByWO.values());
  const woProgress = Array.from(aux.progressByWO.values());

  return (
    <MaterialsView
      bundle={bundle}
      formStatuses={formStatuses}
      woProgress={woProgress}
    />
  );
}
