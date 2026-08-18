import Link from "next/link";
import OrderBuilderView from "@/components/order-builder-view";
import { paintLineFromValue } from "@/lib/customer-form/material-types";
import {
  loadOrderPageData,
  loadLatestBuildForWorkOrder,
} from "@/lib/materials/order-page-data";

export const dynamic = "force-dynamic";

/**
 * Order building — step one of the split Order Materials flow (Kate round-3 #18).
 *
 * A real route rather than an overlay on the work-order page, which is what
 * makes the scroll behave (#21) and what makes the work-order page's
 * focus-triggered `router.refresh()` harmless instead of destructive (#20).
 */
export default async function OrderBuilderPage({
  params,
}: {
  params: Promise<{ woId: string }>;
}) {
  const { woId } = await params;
  const cleanWoId = decodeURIComponent(woId).trim().replace(/^['"]|['"]$/g, "");
  const data = await loadOrderPageData(cleanWoId);

  if (!data) {
    return (
      <div className="max-w-lg mx-auto py-16 text-center">
        <h1 className="text-lg font-bold text-ppp-navy">Work order not available</h1>
        <p className="mt-2 text-sm text-ppp-charcoal-500">
          This work order isn&apos;t in your open-materials list — it may be closed, or outside
          what you can see.
        </p>
        <Link
          href="/dashboard/materials"
          className="mt-6 inline-flex items-center px-4 py-2 min-h-[44px] rounded-lg bg-ppp-blue text-white text-sm font-semibold hover:bg-ppp-blue-600 transition-colors"
        >
          Back to materials
        </Link>
      </div>
    );
  }

  if (!data.canOrderMaterials) {
    return (
      <div className="max-w-lg mx-auto py-16 text-center">
        <h1 className="text-lg font-bold text-ppp-navy">Ordering is admin-only</h1>
        <p className="mt-2 text-sm text-ppp-charcoal-500">
          Account Managers and reps can enter colors, but an admin places the material order.
        </p>
        <Link
          href={`/dashboard/materials/${encodeURIComponent(data.workOrderId)}`}
          className="mt-6 inline-flex items-center px-4 py-2 min-h-[44px] rounded-lg bg-ppp-blue text-white text-sm font-semibold hover:bg-ppp-blue-600 transition-colors"
        >
          Back to work order
        </Link>
      </div>
    );
  }

  // Resume the last supplier this WO was being built for, so re-entering the
  // builder doesn't throw away a half-finished order.
  const latest = await loadLatestBuildForWorkOrder(data.workOrderId);

  return (
    <OrderBuilderView
      workOrderId={data.workOrderId}
      workOrderNumber={data.job.wo.workOrderNumber ?? null}
      customerName={data.job.wo.accountName ?? null}
      sourceLines={data.sourceLines}
      previewGroups={data.previewGroups}
      // Kate round-3 #24: seed the paint line from the work order when the
      // saved build has none. The AM picks a line on Internal Entry, it lands
      // on WorkOrder.MaterialType__c — and the order form still showed an empty
      // dropdown and an orange "Paint line not set" warning, which is exactly
      // the complaint. The fallback chain existed only inside the EMAIL
      // builder, so the email would have carried it while the screen denied it.
      initialPayload={{
        ...latest.payload,
        mainMaterialType:
          latest.payload.mainMaterialType || paintLineFromValue(data.job.wo.materialType) || "",
      }}
      initialSupplierId={latest.supplierAccountId}
      persistenceAvailable={latest.available}
    />
  );
}
