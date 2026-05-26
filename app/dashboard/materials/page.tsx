import { loadDashboardData } from "@/lib/data-source";
import MaterialsView from "@/components/materials-view";
import { deriveOpenMaterialsWorkOrders } from "@/lib/salesforce/materials";
import { getFormStatusByWO, type FormStatus } from "@/lib/customer-form/wo-status";
import { getProgressByWO } from "@/lib/wo-progress/derive";
import type { WoProgress } from "@/components/work-order-progress-bar";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function MaterialsOrderingPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const bundle = await loadDashboardData(sp);

  // Form status + progress timeline run in parallel — same Supabase
  // instance, no inter-dependency. One round trip per query.
  const openJobs = bundle.snapshot ? deriveOpenMaterialsWorkOrders(bundle.snapshot) : [];
  const woIds = openJobs.map((j) => j.wo.id);

  let formStatusByWO: Map<string, FormStatus>;
  let progressByWO: Map<string, WoProgress>;
  try {
    [formStatusByWO, progressByWO] = await Promise.all([
      getFormStatusByWO(woIds),
      getProgressByWO(woIds),
    ]);
  } catch (err) {
    console.error("[materials] supabase load failed:", err);
    formStatusByWO = new Map();
    progressByWO = new Map();
  }

  // Serialize Maps → arrays for client-component props (Maps don't
  // serialize cleanly across the server/client boundary in Next).
  const formStatuses = Array.from(formStatusByWO.values());
  const woProgress = Array.from(progressByWO.values());

  return (
    <MaterialsView
      bundle={bundle}
      formStatuses={formStatuses}
      woProgress={woProgress}
    />
  );
}
