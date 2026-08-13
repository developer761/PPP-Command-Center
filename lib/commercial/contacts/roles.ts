/**
 * Contact roles — pure data, NO server-only import.
 *
 * Same pattern, and the same reason, as `document-categories.ts` and
 * `assignment-roles.ts`: the list lived inside a `server-only` module, so
 * client components could not import it and carried their own copies instead
 * (see `new-account-contacts.tsx`). Every one of those copies is a place the
 * screen can quietly disagree with the constants — which is exactly how
 * Brendan's document-category change failed to land.
 *
 * There is a THIRD place this list lives that no import can reach: the CHECK
 * constraints on `commercial_account_contacts.role` and
 * `commercial_opportunity_contacts.role`. TypeScript cannot see a Postgres
 * constraint, so a role added here and not there is accepted by the compiler,
 * offered on screen, and rejected by the database at save time — precisely the
 * team-roles bug that migration 136 had to repair. A test reads both CHECKs out
 * of the migration files and compares them to this list.
 */

export const CONTACT_ROLES = [
  "decision_maker",
  "estimator",
  "pm",
  // Stephanie 2026-08-13: "each job may have different contacts for site
  // supers, pms, apms, estimators". An assistant PM is usually the person
  // actually answering the phone on a live job, so it earns its own role
  // rather than being filed under "other".
  "apm",
  "superintendent",
  "ap",
  "billing",
  "site",
  "other",
] as const;

export type ContactRole = (typeof CONTACT_ROLES)[number];

export function roleLabel(role: ContactRole | string): string {
  return (
    {
      decision_maker: "Decision Maker",
      estimator: "Estimator",
      pm: "Project Manager",
      apm: "Assistant PM",
      superintendent: "Superintendent",
      ap: "Accounts Payable",
      billing: "Billing",
      site: "Site Contact",
      other: "Other",
    } as Record<string, string>
  )[role] ?? "Other";
}

export function isContactRole(v: string): v is ContactRole {
  return (CONTACT_ROLES as readonly string[]).includes(v);
}
