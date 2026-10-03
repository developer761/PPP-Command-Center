/**
 * Which vendors a person sees on "Build the order", and in what order.
 *
 * Katie settled the rule on 2026-10-02, overruling the first version of this
 * file: "We don't need to sort the vendors based on location relative to the
 * job. We just need to filter the vendors based on location of the team. The
 * guys have relationships with specific stores and will order from a further
 * store because they use that store all the time, they carry specific items,
 * or maybe they're close to where they live, etc. It's not always based on the
 * location of the job. We can make it simple - NJ based guys see NJ Vendors,
 * NY sees NY vendors, etc. Then they can utilize the Favorites feature from
 * that filtered list."
 *
 * So: FILTER, by the PERSON's state. The first version sorted by the JOB's
 * state, which optimized for where the paint was going rather than for who was
 * buying it — a crew's vendor list is a set of standing relationships, not a
 * geography problem.
 *
 * Hiding is safe now in a way it was not a day earlier. The objection then was
 * that three vendors had no state and would vanish; Katie settled all three in
 * the same message (Paints by George is NY, Eco Wall Coatings and Sunbelt stay
 * inactive and are never emailed an order), so every ACTIVE vendor carries a
 * state.
 *
 * Two deliberate escape hatches, both of which only ever show MORE:
 *   · a person with no state set sees everything — filtering on nothing would
 *     hand them an empty picker and no way to understand why;
 *   · a vendor with no state is shown to everyone, because "unknown" is not a
 *     reason to make something unreachable.
 *
 * Pure: no DOM, no fetch.
 */

export type RankableVendor = {
  accountId: string;
  name: string;
  /** Two-letter state, or null when nobody has told us. */
  state?: string | null;
  sortOrder?: number | null;
  isActive?: boolean;
};

export type VendorGroup = "favorite" | "other";

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

/** Is this vendor in scope for somebody working in `userState`? */
export function vendorIsInScope(
  vendorState: string | null | undefined,
  userState: string | null | undefined
): boolean {
  const user = (userState ?? "").trim();
  if (user.length !== 2) return true; // nothing to filter on
  const vendor = (vendorState ?? "").trim();
  if (vendor.length !== 2) return true; // unknown is not a reason to hide
  return sameState(vendorState, userState);
}

/**
 * The vendors this person should see, favorites first.
 *
 * Favorites are picked from WITHIN the filtered list, which is Katie's own
 * sequence — "then they can utilize the Favorites feature from that filtered
 * list". A starred vendor in another state is therefore still hidden; that is
 * the filter doing its job, and the person can clear their state to see
 * everything.
 */
export function rankVendors<T extends RankableVendor>(input: {
  vendors: readonly T[];
  favoriteIds?: readonly string[];
  /** The signed-in person's state, from profiles.state. */
  userState?: string | null;
}): RankedVendor<T>[] {
  const favorites = new Set(input.favoriteIds ?? []);

  return input.vendors
    .filter((v) => vendorIsInScope(v.state, input.userState))
    // Decorated with the incoming index so the sort is stable on every engine:
    // the server already ordered this list (active → sort_order → alpha) and
    // that work must survive rather than be re-derived here.
    .map((vendor, i) => ({
      vendor,
      group: (favorites.has(vendor.accountId) ? "favorite" : "other") as VendorGroup,
      i,
    }))
    .sort((a, b) => (a.group === b.group ? a.i - b.i : a.group === "favorite" ? -1 : 1))
    .map(({ vendor, group }) => ({ vendor, group }));
}

/** Heading for a group. */
export function vendorGroupLabel(group: VendorGroup, userState?: string | null): string {
  if (group === "favorite") return "Your favorites";
  const st = (userState ?? "").trim().toUpperCase();
  return st.length === 2 ? `${st} vendors` : "All vendors";
}
