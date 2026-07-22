import "server-only";

import { loadDashboardData, type LiveDashboardBundle } from "@/lib/data-source";
import {
  deriveOpenMaterialsWorkOrders,
  serializeOpenJobs,
  type SerializedOpenWorkOrderForMaterials,
} from "@/lib/salesforce/materials";
import { getMaterialsPageAuxData } from "@/lib/materials-page-data";
import { loadCoverageConfig } from "@/lib/supplier-order/coverage-config";
import type { CoverageConfig } from "@/lib/supplier-order/estimate-gallons";
import type { FormStatus } from "@/lib/customer-form/wo-status";
import type { WoProgress } from "@/components/work-order-progress-bar";

/**
 * Shared loader for the Materials Ordering surfaces. Both the browse list
 * (`/dashboard/materials`) and the single-WO page (`/dashboard/materials/[woId]`,
 * Kate #1) render the SAME <MaterialsView> with the SAME data — they only
 * differ by which WO is focused. Extracted here so the (non-trivial, perf-tuned)
 * load path lives in one place instead of being duplicated across two routes.
 */
export type MaterialsViewProps = {
  bundle: LiveDashboardBundle;
  formStatuses: FormStatus[];
  woProgress: WoProgress[];
  coverageConfig: CoverageConfig | undefined;
  openJobsSerialized: SerializedOpenWorkOrderForMaterials[];
};

export async function loadMaterialsViewProps(
  sp: Record<string, string | string[] | undefined>
): Promise<MaterialsViewProps> {
  const tStart = Date.now();

  // Coverage config is independent of the bundle — kick it off in parallel so
  // it's usually resolved by the time we need it (helps cold instances).
  const coverageConfigPromise = loadCoverageConfig().catch((err) => {
    console.error("[materials] coverage config load failed:", err);
    return undefined;
  });

  const bundle = await loadDashboardData(sp, { materials: true });
  const openJobs = bundle.snapshot ? deriveOpenMaterialsWorkOrders(bundle.snapshot) : [];

  // Empty-scope fast path — nothing to populate; skip aux + coverage queries.
  if (openJobs.length === 0) {
    return {
      bundle,
      formStatuses: [],
      woProgress: [],
      coverageConfig: undefined,
      openJobsSerialized: [],
    };
  }

  const woIds = openJobs.map((j) => j.wo.id);
  const woMeta = new Map<string, { status: string | null; closeDate: string | null }>();
  for (const j of openJobs) {
    woMeta.set(j.wo.id, { status: j.wo.status, closeDate: j.wo.closeDate });
  }

  const [aux, coverageConfig] = await Promise.all([
    getMaterialsPageAuxData(woIds, woMeta).catch((err) => {
      console.error("[materials] aux data load failed:", err);
      return { formStatusByWO: new Map(), progressByWO: new Map() };
    }),
    coverageConfigPromise,
  ]);

  const formStatuses = Array.from(aux.formStatusByWO.values());
  const woProgress = Array.from(aux.progressByWO.values());

  // Slim the RSC payload — MaterialsView only reads workOrders / woLineItems /
  // accounts / paintColors from the snapshot.
  const slimBundle: LiveDashboardBundle = bundle.snapshot
    ? {
        ...bundle,
        snapshot: {
          ...bundle.snapshot,
          opportunities: [],
          quotes: [],
          transactions: [],
          reviews: [],
          cases: [],
          quotas: [],
          subQuotas: [],
          reps: [],
        },
      }
    : bundle;

  const openJobsSerialized = serializeOpenJobs(openJobs);

  console.log(
    `[materials] view props in ${Date.now() - tStart}ms (openWOs=${openJobs.length})`
  );

  return {
    bundle: slimBundle,
    formStatuses,
    woProgress,
    coverageConfig,
    openJobsSerialized,
  };
}
