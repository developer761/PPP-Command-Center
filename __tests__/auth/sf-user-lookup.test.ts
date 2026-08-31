import { describe, it, expect } from "vitest";
import { pickBestUser, type SfUserCandidate } from "@/lib/auth/sf-user-lookup";

/**
 * Kate, 2026-08-31: Amy Mariani could not sign in. Her ACTIVE Salesforce user
 * is on @precisionpaintingplus.com; an INACTIVE one exists on .net.
 *
 * The old lookup queried the signed-in address first and stopped as soon as
 * that query returned anything — active or not. The dead .net record won, the
 * cross-domain fallback never ran, and a current employee was told her
 * Salesforce user was inactive.
 *
 * The ranking is what was wrong, not the query, so it is tested here on its own.
 */
const user = (o: Partial<SfUserCandidate> & { email: string }): SfUserCandidate => ({
  id: o.id ?? `id-${o.email}`,
  name: o.name ?? "A User",
  isActive: o.isActive ?? true,
  createdDate: o.createdDate ?? "2020-01-01T00:00:00Z",
  email: o.email,
});

describe("choosing which Salesforce user answers for an address", () => {
  it("Amy signs in — the active .com user wins over the dead .net one", () => {
    const best = pickBestUser([
      user({ email: "amariani@precisionpaintingplus.net", isActive: false, createdDate: "2024-01-01T00:00:00Z" }),
      user({ email: "amariani@precisionpaintingplus.com", isActive: true, createdDate: "2019-01-01T00:00:00Z" }),
    ])!;
    expect(best.isActive).toBe(true);
    expect(best.email).toContain(".com");
  });

  it("...and the same the other way round, so neither domain is privileged", () => {
    // The order candidates arrive in is the order the two queries resolve in,
    // which is not guaranteed. Domain must not be a tiebreak at all.
    const best = pickBestUser([
      user({ email: "x@precisionpaintingplus.com", isActive: false, createdDate: "2025-01-01T00:00:00Z" }),
      user({ email: "x@precisionpaintingplus.net", isActive: true, createdDate: "2018-01-01T00:00:00Z" }),
    ])!;
    expect(best.isActive).toBe(true);
    expect(best.email).toContain(".net");
  });

  it("an ACTIVE user beats a NEWER inactive one", () => {
    // Recency is only a tiebreak among equals. A freshly-deactivated record
    // must never outrank a live one.
    const best = pickBestUser([
      user({ email: "a@ppp.net", isActive: false, createdDate: "2026-08-01T00:00:00Z" }),
      user({ email: "a@ppp.com", isActive: true, createdDate: "2015-01-01T00:00:00Z" }),
    ])!;
    expect(best.isActive).toBe(true);
  });

  it("among two active duplicates, the newer one wins", () => {
    // "Mike Adler" vs "Mike Adler WP" — both live, the newer is the real one.
    const best = pickBestUser([
      user({ email: "m@ppp.com", id: "old", createdDate: "2015-01-01T00:00:00Z" }),
      user({ email: "m@ppp.com", id: "new", createdDate: "2024-01-01T00:00:00Z" }),
    ])!;
    expect(best.id).toBe("new");
  });

  it("reports the inactive one when nothing active exists at all", () => {
    // The caller turns them away, and the message says there is no ACTIVE user
    // rather than implying we found theirs and it was switched off.
    const best = pickBestUser([
      user({ email: "gone@ppp.net", isActive: false }),
      user({ email: "gone@ppp.com", isActive: false }),
    ])!;
    expect(best.isActive).toBe(false);
  });

  it("returns nothing when nobody answers to the address", () => {
    expect(pickBestUser([])).toBeNull();
  });

  it("does not mutate the caller's list", () => {
    // The candidates come straight from two concurrent queries; sorting them
    // in place would reorder an array the caller may still be reading.
    const input = [
      user({ email: "b@ppp.net", isActive: false }),
      user({ email: "b@ppp.com", isActive: true }),
    ];
    const before = input.map((u) => u.email);
    pickBestUser(input);
    expect(input.map((u) => u.email)).toEqual(before);
  });

  it("survives a missing CreatedDate", () => {
    const best = pickBestUser([
      user({ email: "c@ppp.com", createdDate: null }),
      user({ email: "c@ppp.net", createdDate: null }),
    ]);
    expect(best).not.toBeNull();
  });
});

describe("the lookup searches both domains rather than stopping at one", () => {
  it("queries both addresses concurrently", async () => {
    const src = (await import("node:fs")).readFileSync(
      (await import("node:path")).join(process.cwd(), "lib/auth/sf-user-lookup.ts"), "utf8"
    );
    // Sequential-with-early-return is the exact shape of the bug: it lets a
    // dead record on the first domain hide a live one on the second.
    expect(src).toMatch(/Promise\.all\(addresses\.map\(queryCandidates\)\)/);
    expect(src, "an early return would re-introduce the shadowing bug")
      .not.toMatch(/if \(!match\)/);
  });
});
