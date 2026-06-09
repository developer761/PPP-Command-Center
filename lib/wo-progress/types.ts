/**
 * Public types for the work-order progress timeline.
 *
 * Pulled out of `components/work-order-progress-bar.tsx` so lib/ + app/ code
 * can import them without taking a dependency on a UI component. The bar
 * component re-exports `WoProgress` for convenience so existing imports
 * continue to work.
 */

export type WoProgress = {
  workOrderId: string;
  workOrderNumber: string | null;
  formSentAt: string | null;
  formOpenedAt: string | null;
  formSubmittedAt: string | null;
  /** When multiple suppliers — earliest draft across them. UI shows
   *  per-supplier sub-rows when there are >1 supplier orders. */
  supplierDraftedAt: string | null;
  supplierSentAt: string | null;
  supplierAcknowledgedAt: string | null;
  materialsDeliveredAt: string | null;
  /** Stamped from Salesforce WorkOrder Status — when Status reaches
   *  "Complete Paid in Full" / "Paid in Full", CloseDate is used as the
   *  jobCompletedAt timestamp. Cancelled/voided/abandoned WOs do NOT count
   *  as complete. See lib/wo-progress/completion.ts. */
  jobCompletedAt: string | null;
  /** Per-supplier breakdown for stages 3-6 (when multi-supplier WO). */
  perSupplier?: Array<{
    supplierAccountId: string;
    supplierName: string;
    draftedAt: string | null;
    sentAt: string | null;
    acknowledgedAt: string | null;
    deliveredAt: string | null;
  }>;
};
