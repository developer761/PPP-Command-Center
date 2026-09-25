/**
 * Vendor directory — the client-safe half (Katie 2026-09-15).
 *
 * "Add all vendors — both retail vendors and labor vendors."
 *
 * Two kinds, and only two, because a purchase only ever asks one question of
 * its vendor: did we buy a THING (a store, a supplier, a rental yard) or pay a
 * PERSON/company for WORK (a Tomco crew payee, a labor company, a sub)?
 *
 * Pure — no server-only import — so the purchase form, the settings page and
 * the tests all read the same lists. The DB CHECK on commercial_vendors.kind /
 * .status must match these; __tests__/commercial/app-lists-match-db-constraints
 * and scripts/check-db-enums.mjs both hold them together.
 */

export const VENDOR_KINDS = ["retail", "labor"] as const;
export type VendorKind = (typeof VENDOR_KINDS)[number];

export const VENDOR_STATUSES = ["active", "inactive"] as const;
export type VendorStatus = (typeof VENDOR_STATUSES)[number];

export function isVendorKind(v: unknown): v is VendorKind {
  return typeof v === "string" && (VENDOR_KINDS as readonly string[]).includes(v);
}

export function isVendorStatus(v: unknown): v is VendorStatus {
  return typeof v === "string" && (VENDOR_STATUSES as readonly string[]).includes(v);
}

export const VENDOR_KIND_META: Record<VendorKind, { label: string; plural: string; blurb: string }> = {
  retail: {
    label: "Retail",
    plural: "Retail vendors",
    blurb: "Stores, suppliers and rental yards — where materials, equipment and permits are bought.",
  },
  labor: {
    label: "Labor",
    plural: "Labor vendors",
    blurb: "Crew payees, labor companies and subs — who Tomco pays for work.",
  },
};

export function vendorKindLabel(kind: string): string {
  return isVendorKind(kind) ? VENDOR_KIND_META[kind].label : "Retail";
}

/**
 * Which kind of vendor a purchase category is ASKING for.
 *
 * `labor` ("Subcontract labor") and `subcontractor` pay someone for work; every
 * other category (materials, equipment, permit, other) buys something. Unknown
 * categories fall to retail, the same way an unknown purchase category falls to
 * "other".
 */
export function vendorKindForCategory(category: string | null | undefined): VendorKind {
  // employee_labor too: a payout to Tomco's own crew is somebody's time,
  // and the payee list for it should offer people, not paint suppliers.
  return category === "labor" || category === "employee_labor" || category === "subcontractor"
    ? "labor"
    : "retail";
}

/**
 * Order a vendor list for a purchase category: the kind the category asks for
 * first, then the rest — alphabetical inside each group.
 *
 * "First", never "only". A permit bought through a labor company, or a sub who
 * also sells materials, is a real purchase; hiding the other kind would make
 * someone type the name by hand and split the vendor in two.
 */
export function orderVendorsForCategory<T extends { name: string; kind: string }>(
  vendors: readonly T[],
  category: string | null | undefined
): T[] {
  const preferred = vendorKindForCategory(category);
  return [...vendors].sort((a, b) => {
    const pa = a.kind === preferred ? 0 : 1;
    const pb = b.kind === preferred ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
  });
}

/**
 * Group key for a vendor name.
 *
 * Lower-cases, drops punctuation, collapses whitespace, and strips the company
 * suffixes people type inconsistently. Deliberately conservative: it will not
 * merge "Sherwin Williams" with "Sherwin", because two genuinely different
 * vendors merged into one row is a worse error than one vendor split in two —
 * you can SEE a split, you cannot see a bad merge.
 *
 * Lives here (not in the vendor-spend report) so the directory's "is this
 * already a vendor?" match and the report's grouping are the SAME rule. The
 * report re-exports it.
 */
export function vendorKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,'"()]/g, "")
    .replace(/\b(inc|llc|ltd|co|corp|company|incorporated)\b/g, "")
    .replace(/[-_/&]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Trim + collapse internal whitespace, capped at the purchase.vendor width. */
export function normalizeVendorName(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Find the directory vendor a typed name means, by {@link vendorKey}. An
 * ACTIVE match wins over an inactive one (two rows can share a key only when
 * one was renamed around the other). Null when nothing matches.
 */
export function matchVendorByName<T extends { name: string; status: string }>(
  vendors: readonly T[],
  typed: string | null | undefined
): T | null {
  const key = vendorKey(normalizeVendorName(typed));
  if (!key) return null;
  let inactive: T | null = null;
  for (const v of vendors) {
    if (vendorKey(v.name) !== key) continue;
    if (v.status === "active") return v;
    inactive ??= v;
  }
  return inactive;
}

/** Display a US phone as (631) 555-1234; anything else is returned trimmed. */
export function formatVendorPhone(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  let digits = s.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10) return s;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}
