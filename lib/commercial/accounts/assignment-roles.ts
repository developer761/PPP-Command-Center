/**
 * PPP-staff assignment roles for commercial accounts.
 *
 * Pure data — NO server-only imports — so client components (the
 * new-account team picker, the Team-tab role pills) can import the
 * enum + label function without pulling the whole DB-side
 * `assignments.ts` lib into the browser bundle.
 *
 * `lib/commercial/accounts/assignments.ts` re-exports these so server
 * callers keep one import path. Do not add DB queries or `server-only`
 * here.
 */

/*
 * Brendan 2026-08-12: "Team Roles should be simple. PPP Staff roles: Sales Rep,
 * Field Rep, Office Rep, Estimator."
 *
 * Seven became four. The three that went — Account Manager, Superintendent,
 * Foreman, Billing Contact — were either PPP job titles that nobody assigns per
 * customer, or a CUSTOMER-side role wearing a PPP-side label (billing contact
 * is a person at the GC, and belongs on Contacts, not on the staff list).
 *
 * A picker with seven options where four are never used is a picker people
 * choose wrongly and then stop trusting.
 */
export const ASSIGNMENT_ROLES = [
  "sales_rep",
  "field_rep",
  "office_rep",
  "estimator",
] as const;
export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];

/** Retired 2026-08-12. Kept only so existing assignments still read. */
const RETIRED_ROLE_LABELS: Record<string, string> = {
  account_manager: "Account Manager",
  // Opportunity-side roles, retired 2026-08-12 in the re-audit: the deal Team
  // tab carried its own vocabulary, still offering three roles Brendan had
  // already removed from the account team. Kept so existing rows still read.
  lead_estimator: "Lead Estimator",
  primary_pm: "Project Manager",
  superintendent: "Superintendent",
  foreman: "Foreman",
  billing_contact: "Billing Contact",
  other: "Other",
};

export function assignmentRoleLabel(role: AssignmentRole | string): string {
  return (
    {
      sales_rep: "Sales Rep",
      field_rep: "Field Rep",
      office_rep: "Office Rep",
      estimator: "Estimator",
      ...RETIRED_ROLE_LABELS,
    } as Record<string, string>
  )[role] ?? "Other";
}
