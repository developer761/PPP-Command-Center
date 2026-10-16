import { describe, it, expect } from "vitest";
import {
  applyReleasedRetainage,
  aiaLineIdentityKey,
  lineRetainageCents,
  releaseBaselineFor,
  certificatesRestatedByRenumber,
  type AiaLineInput,
  type AiaLineIdentity,
  type AiaReleaseCandidate,
  type AiaReleaseBaselinePin,
} from "@/lib/commercial/aia/constants";

/**
 * Two edits that are allowed on the screen and silently restated money.
 *
 *  F6 — renumbering an issued release. Which release a certificate counts from
 *       was chosen by application_number; on LMJ Cipla, sliding release #5
 *       above paid #6 moved #6's line 5 from $50.00 to $4,431.36.
 *  F7 — editing a line's item_no. The release sheet was matched on item_no, so
 *       "1" → "01" moved a line's retainage from $575.00 to $4,025.00.
 *
 * Every assertion is on a computed figure — the retainage a line holds, the
 * release a certificate reads — not on how the code spells it.
 */

type App = AiaReleaseCandidate & AiaReleaseBaselinePin;
const app = (id: string, n: number, over: Partial<App> = {}): App => ({
  id,
  application_number: n,
  status: "paid",
  is_retainage_release: false,
  ...over,
});

describe("F6 · an issued certificate's release baseline does not move", () => {
  // Cipla's shape: ordinary #4, release #5 (paid), ordinary #6 (paid).
  const four = app("a4", 4);
  const release = app("r5", 5, { is_retainage_release: true });
  const six = app("a6", 6);

  it("without a pin, the rule reads the release below", () => {
    expect(releaseBaselineFor(six, [release])?.id).toBe("r5");
  });

  it("a PINNED certificate keeps its release after the release is renumbered above it", () => {
    const pinned = { ...six, release_baseline_app_id: "r5", release_baseline_pinned_at: "2026-10-01T00:00:00Z" };
    const movedRelease = { ...release, application_number: 9 };
    // The rule alone would now find nothing below #6 — the restatement.
    expect(releaseBaselineFor({ ...six }, [movedRelease])).toBeNull();
    expect(releaseBaselineFor(pinned, [movedRelease])?.id).toBe("r5");
  });

  it("a pinned NULL means 'there was no release' — a release renumbered BELOW it is not picked up", () => {
    const two = { ...app("a2", 2), release_baseline_app_id: null, release_baseline_pinned_at: "2026-01-01T00:00:00Z" };
    const early = { ...release, application_number: 1 };
    expect(releaseBaselineFor({ ...two, release_baseline_pinned_at: null }, [early])?.id).toBe("r5");
    expect(releaseBaselineFor(two, [early])).toBeNull();
  });

  it("a DRAFT ignores any pin and tracks the rule", () => {
    const draft = { ...six, status: "draft", release_baseline_app_id: "zzz", release_baseline_pinned_at: "2026-10-01T00:00:00Z" };
    expect(releaseBaselineFor(draft, [release])?.id).toBe("r5");
  });

  it("a pin to a release that is no longer issued reads nothing, not a draft's numbers", () => {
    const pinned = { ...six, release_baseline_app_id: "r5", release_baseline_pinned_at: "2026-10-01T00:00:00Z" };
    expect(releaseBaselineFor(pinned, [{ ...release, status: "draft" }])).toBeNull();
  });

  it("refuses-list: sliding the release above paid #6 names #6", () => {
    const got = certificatesRestatedByRenumber([four, release, six], "r5", 7);
    expect(got.map((a) => a.id)).toEqual(["a6"]);
  });

  it("refuses-list is EMPTY once #6 is pinned — the structural fix blocks nothing", () => {
    const pinned = { ...six, release_baseline_app_id: "r5", release_baseline_pinned_at: "2026-10-01T00:00:00Z" };
    expect(certificatesRestatedByRenumber([four, release, pinned], "r5", 7)).toEqual([]);
  });

  it("shifting a whole series top-first, as Stephanie does, is never refused", () => {
    // 4,5(rel),6 → 6,7,8, highest first, each step against the state before it.
    let apps: App[] = [four, release, six];
    for (const [id, to] of [["a6", 8], ["r5", 7], ["a4", 6]] as const) {
      expect(certificatesRestatedByRenumber(apps, id, to), `${id} → ${to}`).toEqual([]);
      apps = apps.map((a) => (a.id === id ? { ...a, application_number: to } : a));
    }
  });

  it("a release moved past DRAFTS only is not refused", () => {
    const d6 = app("d6", 6, { status: "draft" });
    const d7 = app("d7", 7, { status: "draft" });
    expect(certificatesRestatedByRenumber([four, release, d6, d7], "r5", 9)).toEqual([]);
  });
});

const line = (over: Partial<AiaLineInput & AiaLineIdentity>): AiaLineInput & AiaLineIdentity => ({
  item_no: "1",
  description: "Base contract",
  scheduled_value_cents: 100_000_00,
  from_previous_cents: 0,
  this_period_cents: 0,
  materials_stored_cents: 0,
  ...over,
});

describe("F7 · editing item_no does not drop released retainage", () => {
  // The release let go of $90,000 completed on line 1. The next sheet bills
  // $10,000 more on the same line, so 5% retainage is owed on $10,000 only.
  const releaseLine = line({ id: "rel-line", source_line_id: "root-1", from_previous_cents: 90_000_00 });
  const held = (l: AiaLineInput & AiaLineIdentity) =>
    lineRetainageCents(applyReleasedRetainage([l], [releaseLine])[0], 5);

  it("the untouched line holds 5% of the new work", () => {
    expect(held(line({ id: "n1", item_no: "1", from_previous_cents: 90_000_00, this_period_cents: 10_000_00 }))).toBe(500_00);
  });

  it("'1' → '01' (no chain id, as every pre-migration row) still holds 5% of the new work", () => {
    expect(held(line({ id: "n1", item_no: "01", from_previous_cents: 90_000_00, this_period_cents: 10_000_00 }))).toBe(500_00);
    expect(aiaLineIdentityKey({ item_no: " 1. " })).toBe(aiaLineIdentityKey({ item_no: "1" }));
  });

  it("a line renamed to something unrelated is still matched by its chain id", () => {
    const renamed = line({ id: "n1", source_line_id: "root-1", item_no: "BASE-A", description: "Renamed",
      from_previous_cents: 90_000_00, this_period_cents: 10_000_00 });
    expect(held(renamed)).toBe(500_00);
    // And without the chain id the same rename WOULD lose it — which is why
    // the seed stamps one.
    expect(held({ ...renamed, source_line_id: null })).toBe(5_000_00);
  });

  it("a release line claimed by its chain is not claimed again by a namesake", () => {
    const lines = applyReleasedRetainage(
      [
        line({ id: "n1", source_line_id: "root-1", item_no: "X", from_previous_cents: 90_000_00 }),
        line({ id: "n2", item_no: "1", from_previous_cents: 90_000_00 }),
      ],
      [releaseLine]
    );
    expect(lines[0].retainage_released_cents).toBe(90_000_00);
    expect(lines[1].retainage_released_cents).toBeUndefined();
  });

  it("does not merge genuinely different numbers", () => {
    expect(aiaLineIdentityKey({ item_no: "10" })).not.toBe(aiaLineIdentityKey({ item_no: "1" }));
    expect(aiaLineIdentityKey({ item_no: "1A" })).not.toBe(aiaLineIdentityKey({ item_no: "1" }));
  });
});
