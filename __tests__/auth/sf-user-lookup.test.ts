import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

/**
 * Jason Ng, 2026-09-03 — the case no email rule can reach.
 *
 * He signs in as jason.eng@precisionpaintingplus.net. Salesforce has that exact
 * address on "Jason Eng-inactive" (deactivated), while his live record is
 * "Jason Ng" <jason.ng@precisionpaintingplus.com>. The cross-domain swap that
 * rescued Amy — and 42 others, counted against production — cannot help: the
 * LOCAL part differs, so there is nothing to swap.
 *
 * The resolution is an admin-asserted row in sf_user_links, not a fuzzy match.
 * These pin the RANKING that row participates in, which is the part that can
 * silently go wrong: pickBestUser is pure, so the ordering is testable without
 * Salesforce, exactly as the cross-domain fix left it.
 */
describe("an admin-set link ranks against what the email search finds", () => {
  const linkedActive = {
    id: "005JasonNgActive", name: "Jason Ng",
    email: "jason.ng@precisionpaintingplus.com", isActive: true, createdDate: "2021-01-01T00:00:00Z",
  };
  const linkedDead = {
    id: "005JasonEngOld", name: "Jason Eng-inactive",
    email: "jason.eng@precisionpaintingplus.net", isActive: false, createdDate: "2019-01-01T00:00:00Z",
  };
  const emailActive = {
    id: "005SomeoneActive", name: "Someone Live",
    email: "jason.eng@precisionpaintingplus.net", isActive: true, createdDate: "2024-01-01T00:00:00Z",
  };

  it("an active record still beats an inactive one, link or not", () => {
    // The rule the link must never be allowed to invert.
    expect(pickBestUser([linkedDead, emailActive])?.id).toBe(emailActive.id);
  });

  it("the address alone resolves to the DEAD record — which is why a link is needed", () => {
    // Only the inactive Jason Eng carries jason.eng@; nothing about the address
    // can reach Jason Ng. This is the bug, asserted rather than described.
    expect(pickBestUser([linkedDead])?.isActive).toBe(false);
    expect(linkedDead.email).not.toBe(linkedActive.email);
    expect(linkedDead.email.split("@")[0]).not.toBe(linkedActive.email.split("@")[0]);
  });

  it("the linked record is a normal candidate — being linked does not make it active", () => {
    expect(pickBestUser([linkedActive])?.isActive).toBe(true);
    expect(pickBestUser([linkedDead])?.isActive).toBe(false);
  });

  it("resolves the link by Id, never by trusting the stored name/email", () => {
    // A row that cached isActive would let a deactivated employee keep signing
    // in forever. The lookup must re-read Salesforce.
    const src = readFileSync(join(process.cwd(), "lib/auth/sf-user-lookup.ts"), "utf8");
    expect(src).toMatch(/FROM User WHERE Id = '\$\{sfUserId\}'/);
    expect(src).toMatch(/if \(linked\?\.isActive\) return linked;/);
    // and the Id is validated before it reaches SOQL
    expect(src).toMatch(/\^\[a-zA-Z0-9\]\{15,18\}\$/);
  });

  it("never fuzzy-matches the address", () => {
    const src = readFileSync(join(process.cwd(), "lib/auth/sf-user-lookup.ts"), "utf8");
    // No edit-distance / LIKE / startsWith matching may enter this file: one
    // character separates jason.eng from jason.ng, and also separates people
    // who are not each other.
    expect(src).not.toMatch(/levenshtein|editDistance|similar/i);
    expect(src).not.toMatch(/Email LIKE/);
  });
});
