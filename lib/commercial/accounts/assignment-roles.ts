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

export const ASSIGNMENT_ROLES = [
  "sales_rep",
  "account_manager",
  "primary_pm",
  "superintendent",
  "foreman",
  "billing_contact",
  "other",
] as const;
export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];

export function assignmentRoleLabel(role: AssignmentRole): string {
  return {
    sales_rep: "Sales Rep",
    account_manager: "Account Manager",
    primary_pm: "Project Manager",
    superintendent: "Superintendent",
    foreman: "Foreman",
    billing_contact: "Billing Contact",
    other: "Other",
  }[role];
}
