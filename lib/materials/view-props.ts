import "server-only";

import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
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
  /** Per-WOLI sqft overrides (Kate #17) keyed by WorkOrderLineItem Id. */
  sqftOverrides: Record<string, number>;
};

/** Command Center follow-up dates (migration 146). Deploy-safe: returns {} if
 *  the table doesn't exist yet.
 *
 *  Kate round-3 #13 — these are authoritative for the Command Center. The
 *  Salesforce value (WorkOrder.FollowupDate__c) remains the fallback, so a date
 *  set directly in Salesforce still shows. */
async function loadFollowupDates(): Promise<Record<string, string>> {
  try {
    const sb = createSupabaseAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SECRET_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const { data, error } = await sb.from("wo_followup_dates").select("work_order_id, followup_date");
    if (error || !data) return {};
    const out: Record<string, string> = {};
    for (const r of data as Array<{ work_order_id: string; followup_date: string }>) {
      if (r.followup_date) out[r.work_order_id] = String(r.followup_date).slice(0, 10);
    }
    return out;
  } catch {
    return {};
  }
}

/** Load all manually-entered sqft overrides (migration 073). Deploy-safe:
 *  returns {} if the table doesn't exist yet or the query fails. */
async function loadSqftOverrides(): Promise<Record<string, number>> {
  try {
    const sb = createSupabaseAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SECRET_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const { data, error } = await sb
      .from("wo_li_sqft_overrides")
      .select("woli_id,sqft");
    if (error || !data) return {};
    const out: Record<string, number> = {};
    for (const r of data as Array<{ woli_id: string; sqft: number }>) {
      out[r.woli_id] = r.sqft;
    }
    return out;
  } catch {
    return {};
  }
}

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
      sqftOverrides: {},
    };
  }

  const woIds = openJobs.map((j) => j.wo.id);
  const woMeta = new Map<string, { status: string | null; closeDate: string | null }>();
  for (const j of openJobs) {
    woMeta.set(j.wo.id, { status: j.wo.status, closeDate: j.wo.closeDate });
  }

  const [aux, coverageConfig, sqftOverrides, followupDates] = await Promise.all([
    getMaterialsPageAuxData(woIds, woMeta).catch((err) => {
      console.error("[materials] aux data load failed:", err);
      return { formStatusByWO: new Map(), progressByWO: new Map() };
    }),
    coverageConfigPromise,
    loadSqftOverrides(),
    loadFollowupDates(),
  ]);

  // Kate round-3 #13: the Command Center's own follow-up date wins over the
  // Salesforce one, so every downstream consumer (the WO page field, the list,
  // the Mail Hub link) agrees without needing to know there are two places a
  // follow-up date can live.
  //
  // COPY, never mutate. deriveOpenMaterialsWorkOrders memoises its result in a
  // WeakMap keyed by the snapshot, and that snapshot is a shared cached object
  // serving every request until it rolls. Writing `job.wo.followupDate = …`
  // wrote into that shared cache: the value then survived for other users, and
  // — because we only ever assign a value that EXISTS — clearing a follow-up
  // date left the old one stuck in the cache instead of falling back to
  // Salesforce. A null local value now explicitly clears.
  const jobsWithLocalFollowup =
    Object.keys(followupDates).length === 0
      ? openJobs
      : openJobs.map((job) =>
          Object.prototype.hasOwnProperty.call(followupDates, job.wo.id)
            ? { ...job, wo: { ...job.wo, followupDate: followupDates[job.wo.id] } }
            : job
        );

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

  const openJobsSerialized = serializeOpenJobs(jobsWithLocalFollowup);

  console.log(
    `[materials] view props in ${Date.now() - tStart}ms (openWOs=${openJobs.length})`
  );

  return {
    bundle: slimBundle,
    formStatuses,
    woProgress,
    coverageConfig,
    openJobsSerialized,
    sqftOverrides,
  };
}
