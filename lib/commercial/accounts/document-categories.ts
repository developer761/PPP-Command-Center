/**
 * Account document categories — pure data, NO server-only import.
 *
 * Same pattern as `assignment-roles.ts`, and extracted for the same reason it
 * was: the upload form is a client component and could not import
 * `documents.ts`, so it carried its own hardcoded copy of this list.
 *
 * That copy is exactly how Brendan's change failed to land. Four categories
 * were retired from the enum on 2026-08-12 — COI, W-9, Master Service
 * Agreement, Safety/OSHA — and the form went on offering all four, with COI
 * still selected by default. The constants said one thing and the screen said
 * another, which is worse than not having made the change at all.
 *
 * `lib/commercial/accounts/documents.ts` re-exports these so server callers
 * keep one import path. Do not add DB queries or `server-only` here.
 */

export const DOCUMENT_CATEGORIES = [
  "vendor_onboarding",
  "other",
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

/**
 * Retired 2026-08-12 (Brendan: "the only thing for the account level really
 * would be prequal questionnaire"). Not offered on upload; still NAMED, so
 * documents filed under them before that date keep reading properly instead of
 * rendering as blanks.
 */
export const RETIRED_DOCUMENT_CATEGORIES = [
  "coi",
  "w9",
  "master_agreement",
  "safety",
] as const;

export function documentCategoryLabel(c: DocumentCategory | string): string {
  return (
    {
      vendor_onboarding: "Prequal Questionnaire",
      other: "Other",
      coi: "Certificate of Insurance (COI)",
      w9: "W-9",
      master_agreement: "Master Service Agreement",
      safety: "Safety / OSHA",
    } as Record<string, string>
  )[c] ?? "Other";
}
