/**
 * The stage tag on a work-order card.  (Kate, batch 6)
 *
 * "The tag on work orders is Submitted no matter where the work order is in the
 * order progression."
 *
 * It was right, as far as it went: the badge only ever modelled the COLOUR FORM
 * lifecycle — sent, opened, submitted, expired — and stopped there. Everything
 * after the customer picks colours is the SUPPLIER ORDER lifecycle, which the
 * card already carried and the badge simply ignored. So a job whose paint was
 * ordered a week ago and delivered yesterday still read "Submitted", and the
 * rail could not be scanned for what actually needed doing.
 *
 * Two phases, and the emoji says which you are in:
 *
 *   🎨 Sent · 🎨 Opened · 🎨 Submitted     — getting colours out of the customer
 *   🚛 Ordered · 🚛 Canceled · 🚛 Delivered — getting paint out of the vendor
 */

export type WoStage =
  | "none" | "sent" | "opened" | "submitted" | "expired"
  | "ordered" | "cancelled" | "delivered";

/** Only the timestamps that decide a stage. */
export type StageProgress = {
  formSentAt?: string | null;
  formOpenedAt?: string | null;
  formSubmittedAt?: string | null;
  supplierSentAt?: string | null;
  /** Set ONLY when every order on the work order is cancelled — a job with a
   *  cancelled order and a live one is still ordered. See deriveOrderStages. */
  supplierCancelledAt?: string | null;
  materialsDeliveredAt?: string | null;
};

/**
 * The furthest stage this work order has reached.
 *
 * Furthest, not latest-event: these timestamps are not guaranteed to arrive in
 * order and some never arrive at all. A form whose token expired after the
 * customer already submitted is still submitted, and paint that was delivered
 * does not stop being delivered because an old token lapsed. Ranking by
 * progression rather than by clock is what keeps the tag honest.
 */
export function deriveWoStage(
  formStatus: { status: WoStage | "none" } | null | undefined,
  progress: StageProgress | null | undefined
): WoStage {
  const p = progress ?? {};

  // ── Order phase ── furthest first.
  if (p.materialsDeliveredAt) return "delivered";
  // Cancelled outranks ordered but NOT delivered: paint that arrived cannot be
  // un-arrived, and `supplierCancelledAt` only means no order is live now.
  if (p.supplierCancelledAt) return "cancelled";
  if (p.supplierSentAt) return "ordered";

  // ── Colour-form phase ──
  if (p.formSubmittedAt || formStatus?.status === "submitted") return "submitted";
  // Expired sits ABOVE opened/sent because it is the one that needs an action —
  // resend — while the other two are simply waiting. It sits BELOW submitted
  // because a lapsed token after a submission changes nothing.
  if (formStatus?.status === "expired") return "expired";
  if (p.formOpenedAt || formStatus?.status === "opened") return "opened";
  if (p.formSentAt || formStatus?.status === "sent") return "sent";

  return "none";
}

export type StageBadge = { label: string; title: string; tone: "green" | "blue" | "charcoal" | "orange" | "navy" };

/**
 * Kate's labels, verbatim — including "Canceled", which the UI spells her way
 * even though the underlying status is `cancelled`.
 */
export const STAGE_BADGES: Record<Exclude<WoStage, "none">, StageBadge> = {
  sent: {
    label: "🎨 Sent",
    title: "Colour form emailed — waiting on the customer",
    tone: "charcoal",
  },
  opened: {
    label: "🎨 Opened",
    title: "Customer opened the form but hasn't submitted yet",
    tone: "blue",
  },
  submitted: {
    label: "🎨 Submitted",
    title: "Customer submitted colours — ready to order materials",
    tone: "green",
  },
  expired: {
    label: "⏳ Expired",
    title: "Token expired — resend the form to get fresh access",
    tone: "orange",
  },
  ordered: {
    label: "🚛 Ordered",
    title: "Materials ordered from the supplier — waiting on delivery",
    tone: "navy",
  },
  cancelled: {
    label: "🚛 Canceled",
    title: "Every order on this job was cancelled — it needs ordering again",
    tone: "orange",
  },
  delivered: {
    label: "🚛 Delivered",
    title: "Materials delivered",
    tone: "green",
  },
};
