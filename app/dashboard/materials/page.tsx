import { loadDashboardData } from "@/lib/data-source";
import MaterialsView from "@/components/materials-view";
import { deriveOpenMaterialsWorkOrders } from "@/lib/salesforce/materials";
import { getMaterialsPageAuxData } from "@/lib/materials-page-data";
import { loadCoverageConfig } from "@/lib/supplier-order/coverage-config";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function MaterialsOrderingPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  // Server-side timing — Karan 2026-06-14: he was seeing >1.5s on the
  // materials page in production. Log every step's wall-clock so Vercel
  // logs reveal whether the slowness is the bundle (cold cache), the
  // aux query, the RSC serialize, or something else.
  const tStart = Date.now();
  const tBundleStart = tStart;

  // Materials-only bundle (~200KB) — pre-derived from the thin snapshot
  // and cached as its own Supabase row. Skips parsing the 5-10MB thin
  // blob on every request. Cuts warm-cache page time roughly 5×.
  // Cron warms this alongside thin + full so cold loads stay rare.
  // Shipped 2026-06-13.
  //
  // PARALLELIZED 2026-06-14: kick off the coverage-config Supabase query
  // alongside the bundle fetch. Coverage doesn't depend on bundle data,
  // so previously waiting until after the bundle resolved was wasting
  // 50-100ms on the critical path. Module-cached after first call so
  // this only helps cold instances — but those are the ones that hurt
  // the 1.5s number.
  const coverageConfigPromise = loadCoverageConfig().catch((err) => {
    console.error("[materials] coverage config load failed:", err);
    return undefined;
  });
  const bundle = await loadDashboardData(sp, { materials: true });
  const tBundleMs = Date.now() - tBundleStart;

  // Speed: ONE consolidated Supabase load builds both the form-status
  // map + the progress timeline map from the same connection. Was two
  // separate loaders (getFormStatusByWO + getProgressByWO) that each
  // opened their own Supabase client and made redundant queries — ~300-
  // 600ms wasted per page load. Now: 2 Supabase queries total (1 to
  // customer_form_tokens, 1 to supplier_orders), run in parallel.
  const tDeriveStart = Date.now();
  const openJobs = bundle.snapshot ? deriveOpenMaterialsWorkOrders(bundle.snapshot) : [];
  const woIds = openJobs.map((j) => j.wo.id);
  const tDeriveMs = Date.now() - tDeriveStart;

  // Empty-scope fast path — a worker with no assigned open WOs (or an
  // admin viewing as such a rep) lands here. Skip both the aux Supabase
  // round-trip AND the coverage-config query; the "No open paint jobs"
  // empty state in MaterialsView only needs `bundle`. Saves 50–200ms on
  // cold loads where there's nothing to populate anyway.
  if (openJobs.length === 0) {
    console.log(
      `[materials] EMPTY-SCOPE in ${Date.now() - tStart}ms (bundle=${tBundleMs}, derive=${tDeriveMs})`
    );
    return (
      <MaterialsView
        bundle={bundle}
        formStatuses={[]}
        woProgress={[]}
        initialWoId={null}
        coverageConfig={undefined}
      />
    );
  }

  // Pass WO Status + CloseDate to the progress-bar builder so the Job
  // Complete stage advances automatically when the WO is marked
  // "Complete Paid in Full" in Salesforce — no manual admin action needed.
  const woMeta = new Map<string, { status: string | null; closeDate: string | null }>();
  for (const j of openJobs) {
    woMeta.set(j.wo.id, { status: j.wo.status, closeDate: j.wo.closeDate });
  }

  // Aux (form statuses + progress timeline) needs the WO ids from the
  // snapshot. Coverage config was kicked off BEFORE the bundle (line ~30)
  // so it's likely already resolved by now — we just await the promise.
  const tAuxStart = Date.now();
  const [aux, coverageConfig] = await Promise.all([
    getMaterialsPageAuxData(woIds, woMeta).catch((err) => {
      console.error("[materials] aux data load failed:", err);
      return { formStatusByWO: new Map(), progressByWO: new Map() };
    }),
    coverageConfigPromise,
  ]);
  const tAuxMs = Date.now() - tAuxStart;

  // Serialize Maps → arrays for client-component props (Maps don't
  // serialize cleanly across the server/client boundary in Next).
  const formStatuses = Array.from(aux.formStatusByWO.values());
  const woProgress = Array.from(aux.progressByWO.values());

  // Deep-link support: ?wo=<id> pre-selects that work order (links from
  // Customer History, the mail timeline, the activity feed, search, etc. all
  // expect the WO to open, not dump the user on the full list).
  const rawWo = sp.wo;
  const initialWoId = typeof rawWo === "string" ? rawWo : Array.isArray(rawWo) ? rawWo[0] : null;

  // SPEED ROUND 9 — RSC payload slim. MaterialsView only reads workOrders,
  // woLineItems, accounts, paintColors from the snapshot. The thin-mode
  // bundle still carries opportunities (already filtered to recent), reps,
  // quotes, transactions, reviews, cases, leadStats — none of which the
  // materials page consumes. Zero them out before serializing across the
  // server/client boundary so the RSC payload drops by ~150-300ms of
  // parse-time + ~1-3MB of JSON-stringify work per page load.
  const slimBundle: typeof bundle = bundle.snapshot
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

  const tTotal = Date.now() - tStart;
  console.log(
    `[materials] page rendered in ${tTotal}ms (bundle=${tBundleMs}, derive=${tDeriveMs}, aux=${tAuxMs}, openWOs=${openJobs.length})`
  );

  return (
    <MaterialsView
      bundle={slimBundle}
      formStatuses={formStatuses}
      woProgress={woProgress}
      initialWoId={initialWoId ?? null}
      coverageConfig={coverageConfig}
    />
  );
}
