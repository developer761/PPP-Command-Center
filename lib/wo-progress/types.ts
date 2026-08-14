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
  /** Kate round-2 #04: when colors were submitted via INTERNAL ENTRY (an AM
   *  entering on the customer's behalf, token kind='internal'), this is that
   *  staffer's display name so the bar reads "Amy Submitted" instead of
   *  "Customer Submitted". Null for a real customer submission. */
  submittedByName?: string | null;
  /** Kate round-3 #03: who did each thing, so the activity history stops being
   *  ambiguous about customer vs account manager.
   *
   *  `entryMode` is the discriminator — an INTERNAL token means the person who
   *  opened and submitted the form was PPP staff acting for the customer, so
   *  every event on that token is attributed to them. A normal token means the
   *  open and the submit were the customer's. */
  entryMode?: "internal" | "customer" | null;
  /** Staffer who sent (or created) the form link. Always PPP-side. */
  sentByName?: string | null;
  /** Who opened the form. Null on a customer token — the customer isn't a
   *  named user — which the UI renders as "by the customer". */
  openedByName?: string | null;
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
