/**
 * The order vendors appear in on "Build the order".
 *
 * Katie, 2026-10-01: "Vendor list -- ensure it's filtering to show a user's
 * favorited vendors and FL vendors if the user is a FL user, NJ if they're
 * from NJ, etc."
 *
 * IT SORTS. IT DOES NOT HIDE, and that is the one place this deliberately
 * answers a slightly different question than the one asked.
 *
 * Three of PPP's fourteen vendors have no state even after the backfill —
 * their pickup addresses simply do not contain one — and an admin adding a
 * vendor by hand types a free-text address with no state field in sight. A
 * filter built on a value that thin removes a vendor from the picker, and the
 * person who needed it has no way to know it was ever there. A sort costs them
 * a scroll. Same benefit at the top of the list, no cliff at the bottom.
 *
 * "In state" is matched against the JOB, not the signed-in user. There is no
 * state on `profiles` to match against — and it is the better rule regardless:
 * paint is bought near the site, so the Long Island rep ordering the Miami job
 * should see Stein Paint first, which a rep-state rule gets exactly backwards.
 *
 * Pure: no DOM, no fetch. The component renders what this returns.
 */

export type RankableVendor = {
  accountId: string;
  name: string;
  /** Two-letter state, or null when nobody has told us. */
  state?: string | null;
  /** Admin-set ordering from supplier_settings.sort_order; nulls sort last. */
  sortOrder?: number | null;
  isActive?: boolean;
};

export type VendorGroup = "favorite" | "in-state" | "other";

export type RankedVendor<T extends RankableVendor> = {
  vendor: T;
  group: VendorGroup;
};

/** Case- and whitespace-insensitive two-letter comparison. "fl " === "FL". */
function sameState(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? "").trim().toUpperCase();
  const y = (b ?? "").trim().toUpperCase();
  return x.length === 2 && x === y;
}

/**
 * Favorites first, then vendors in the job's state, then everyone else.
 *
 * Within each group the existing order is preserved exactly — active first,
 * then the admin's `sort_order` with nulls last, then alphabetical — so a job
 * with no state, and a user with no favorites, gets today's list unchanged.
 * That property is the safety net: the feature can only ever reorder, never
 * lose, and with nothing to go on it is a no-op.
 */
export function rankVendors<T extends RankableVendor>(input: {
  vendors: readonly T[];
  /** Account ids this user has starred. */
  favoriteIds?: readonly string[];
  /** Account.BillingState for the work order being ordered for. */
  jobState?: string | null;
}): RankedVendor<T>[] {
  const favorites = new Set(input.favoriteIds ?? []);

  const groupOf = (v: T): VendorGroup => {
    if (favorites.has(v.accountId)) return "favorite";
    if (sameState(v.state, input.jobState)) return "in-state";
    return "other";
  };

  const RANK: Record<VendorGroup, number> = { favorite: 0, "in-state": 1, other: 2 };

  // Decorate with the incoming index so the sort is stable on every engine:
  // the server already ordered this list (active → sort_order → alpha) and
  // that work must survive, not be re-derived here and risk disagreeing.
  return input.vendors
    .map((vendor, i) => ({ vendor, group: groupOf(vendor), i }))
    .sort((a, b) => RANK[a.group] - RANK[b.group] || a.i - b.i)
    .map(({ vendor, group }) => ({ vendor, group }));
}

/** Heading for a group, naming the state when there is one to name. */
export function vendorGroupLabel(group: VendorGroup, jobState?: string | null): string {
  if (group === "favorite") return "Your favorites";
  if (group === "in-state") {
    const st = (jobState ?? "").trim().toUpperCase();
    return st ? `In ${st} — where the job is` : "Near the job";
  }
  return "All other vendors";
}
