/**
 * Client-safe notification kind → human label + category. Used by the bell and
 * the full Notifications pages so a `kind` string always renders a friendly
 * badge. No server imports — safe in client components.
 */

export type NotificationCategory = "info" | "success" | "warning" | "danger";

type KindMeta = { label: string; category: NotificationCategory };

const KIND_META: Record<string, KindMeta> = {
  // Residential Command Center
  customer_form_submitted: { label: "Colors submitted", category: "success" },
  // Commercial — team
  commercial_account_team_added: { label: "Added to a GC team", category: "info" },
  commercial_opportunity_team_added: { label: "Added to a deal team", category: "info" },
  commercial_task_assigned: { label: "Task assigned", category: "info" },
  commercial_task_overdue: { label: "Task overdue", category: "warning" },
  commercial_note_mention: { label: "You were mentioned", category: "info" },
  commercial_opp_note_added: { label: "New note on a deal", category: "info" },
  commercial_opp_status_changed: { label: "Deal status changed", category: "info" },
  commercial_document_expiring: { label: "Document expiring", category: "warning" },
  commercial_hot_deal_cooling: { label: "Hot deal cooling", category: "warning" },
  commercial_debrief_overdue: { label: "Debrief needed", category: "warning" },
  // Commercial — invoicing
  commercial_invoice_created: { label: "Invoice created", category: "info" },
  commercial_invoice_payment_recorded: { label: "Payment recorded", category: "success" },
  commercial_invoice_paid_full: { label: "Paid in full", category: "success" },
  commercial_invoice_dunning: { label: "Past-due reminder", category: "warning" },
  // Commercial — proposals
  commercial_proposal_sent: { label: "Proposal sent", category: "info" },
  commercial_proposal_approval_requested: { label: "Approval requested", category: "warning" },
  commercial_proposal_approved: { label: "Proposal approved", category: "success" },
  commercial_proposal_changes_requested: { label: "Changes requested", category: "warning" },
  // Commercial — custom alert rules (Block 3B)
  commercial_custom_rule: { label: "Custom alert", category: "warning" },
};

/** Friendly label for a notification kind (falls back to a de-prefixed,
 *  title-cased version of the raw kind for any future kind not yet mapped). */
export function notificationKindLabel(kind: string): string {
  const meta = KIND_META[kind];
  if (meta) return meta.label;
  return kind
    .replace(/^commercial_/, "")
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

export function notificationKindCategory(kind: string): NotificationCategory {
  return KIND_META[kind]?.category ?? "info";
}

/** Tailwind classes for a kind badge, by category. */
export function notificationBadgeClasses(kind: string): string {
  switch (notificationKindCategory(kind)) {
    case "success":
      return "bg-emerald-50 text-emerald-700 border-emerald-200";
    case "warning":
      return "bg-amber-50 text-amber-700 border-amber-200";
    case "danger":
      return "bg-rose-50 text-rose-700 border-rose-200";
    default:
      return "bg-ppp-charcoal-50 text-ppp-charcoal-600 border-ppp-charcoal-200";
  }
}

/** The distinct kinds for a platform, for the filter dropdown. */
export function notificationKindsForPlatform(
  platform: "commercial" | "command_center"
): { value: string; label: string }[] {
  const keys = Object.keys(KIND_META).filter((k) =>
    platform === "commercial" ? k.startsWith("commercial_") : !k.startsWith("commercial_")
  );
  return keys.map((k) => ({ value: k, label: notificationKindLabel(k) }));
}
