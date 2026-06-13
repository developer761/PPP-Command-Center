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
  // Thin snapshot — materials page only consumes workOrders / woLineItems /
  // accounts / paintColors, so we skip the 89k-record Opportunity fetch +
  // 6 secondary queries (quotes, quotas, transactions, reviews, cases,
  // leadStats). Cuts cold-cache load from ~8-15s to ~2-4s. Separate cache
  // key so the dashboard's full snapshot isn't poisoned. Shipped 2026-06-06.
  const bundle = await loadDashboardData(sp, { thin: true });

  // Speed: ONE consolidated Supabase load builds both the form-status
  // map + the progress timeline map from the same connection. Was two
  // separate loaders (getFormStatusByWO + getProgressByWO) that each
  // opened their own Supabase client and made redundant queries — ~300-
  // 600ms wasted per page load. Now: 2 Supabase queries total (1 to
  // customer_form_tokens, 1 to supplier_orders), run in parallel.
  const openJobs = bundle.snapshot ? deriveOpenMaterialsWorkOrders(bundle.snapshot) : [];
  const woIds = openJobs.map((j) => j.wo.id);

  // Empty-scope fast path — a worker with no assigned open WOs (or an
  // admin viewing as such a rep) lands here. Skip both the aux Supabase
  // round-trip AND the coverage-config query; the "No open paint jobs"
  // empty state in MaterialsView only needs `bundle`. Saves 50–200ms on
  // cold loads where there's nothing to populate anyway.
  if (openJobs.length === 0) {
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
  // snapshot; coverage config is independent. Run both concurrently — the
  // sequential await was wasting 200–400ms on every page load (the coverage
  // query is a single small Supabase round-trip that doesn't depend on aux).
  const [aux, coverageConfig] = await Promise.all([
    getMaterialsPageAuxData(woIds, woMeta).catch((err) => {
      console.error("[materials] aux data load failed:", err);
      return { formStatusByWO: new Map(), progressByWO: new Map() };
    }),
    loadCoverageConfig().catch((err) => {
      console.error("[materials] coverage config load failed:", err);
      return undefined;
    }),
  ]);

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
