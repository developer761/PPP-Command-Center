import "server-only";

import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { loadDashboardData, type LiveDashboardBundle } from "@/lib/data-source";
import {
  deriveOpenMaterialsWorkOrders,
  serializeOpenJobs,
  type SerializedOpenWorkOrderForMaterials,
} from "@/lib/salesforce/materials";
import { getMaterialsPageAuxData } from "@/lib/materials-page-data";
import { resolveWorkOrderId } from "@/lib/materials/resolve-wo";
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

/** Worker-typed square footage for a SPECIFIC set of line items (migration
 *  073). Used by the order path, which must see the same numbers the work-order
 *  page shows. Deploy-safe: returns {} on any failure. */
export async function loadSqftOverridesFor(woliIds: string[]): Promise<Record<string, number>> {
  if (woliIds.length === 0) return {};
  try {
    const sb = createSupabaseAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SECRET_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const { data, error } = await sb
      .from("wo_li_sqft_overrides")
      .select("woli_id,sqft")
      .in("woli_id", woliIds);
    if (error || !data) return {};
    const out: Record<string, number> = {};
    for (const r of data as Array<{ woli_id: string; sqft: number }>) out[r.woli_id] = r.sqft;
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
  sp: Record<string, string | string[] | undefined>,
  /** Set by /dashboard/materials/[woId]. See the narrowing note below. */
  opts: { focusWoId?: string | null } = {}
): Promise<MaterialsViewProps> {
  const tStart = Date.now();

  // Coverage config is independent of the bundle — kick it off in parallel so
  // it's usually resolved by the time we need it (helps cold instances).
  const coverageConfigPromise = loadCoverageConfig().catch((err) => {
    console.error("[materials] coverage config load failed:", err);
    return undefined;
  });

  const bundle = await loadDashboardData(sp, { materials: true });
  const allOpenJobs = bundle.snapshot ? deriveOpenMaterialsWorkOrders(bundle.snapshot) : [];

  // The single-WO page is the canonical deep-link target — the Salesforce "Open
  // in Command Center" button, the mail timeline, the activity feed and global
  // search all land here. It was doing the entire board's work to render one
  // job: 460 open work orders (measured against production 2026-08-19) with all
  // their line items serialized into the RSC payload, and the aux queries —
  // form statuses and progress — run across all 460 ids.
  //
  // Safe to narrow because every aggregate the client computes from this list
  // (the stat strip, needs-attention, the "waiting on line items" banner) is
  // rendered inside `{!focusMode && …}`. Focus mode reads exactly one job.
  // If the id doesn't resolve, fall through with an empty list — the client
  // already has a "work order not found" state for that.
  const openJobs = opts.focusWoId
    ? (() => {
        const id = resolveWorkOrderId(opts.focusWoId!, allOpenJobs);
        const job = id ? allOpenJobs.find((j) => j.wo.id === id) : null;
        return job ? [job] : [];
      })()
    : allOpenJobs;

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
    // Narrowed alongside the job list: the WO page needs overrides for its own
    // line items, not for every open job on the board.
    opts.focusWoId
      ? loadSqftOverridesFor(openJobs.flatMap((j) => j.lineItems.map((li) => li.raw.id)))
      : loadSqftOverrides(),
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
    `[materials] view props in ${Date.now() - tStart}ms (openWOs=${openJobs.length}` +
      (opts.focusWoId ? ` of ${allOpenJobs.length}, focused)` : ")")
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
