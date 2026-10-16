import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { pickReleaseApplication, type AiaReleaseCandidate } from "@/lib/commercial/aia/constants";
import { stripComments } from "../helpers/strip-comments";

/**
 * ONE rule for "which release application does this certificate read?".
 *
 * There were two, and they were maintained apart. `listAiaLineItemsWithRelease`
 * said it in Postgres — `is_retainage_release`, `.lt(application_number)`,
 * status in (submitted, paid), order desc, limit 1 — and `aiaBillingRollupBulk`
 * said the same sentence again as a JS loop. The first prints the G702 the GC
 * pays from; the second feeds AR aging, the emailed statement, receivables,
 * Account 360, the deal page and the assistant. They agreed when read side by
 * side on 2026-10-16, and nothing whatsoever made them agree.
 *
 * On LMJ Cipla, reading the baseline wrong costs $4,381.36.
 */

const app = (n: number, over: Partial<AiaReleaseCandidate> = {}): AiaReleaseCandidate => ({
  id: `app-${n}`,
  application_number: n,
  status: "submitted",
  is_retainage_release: true,
  ...over,
});

describe("pickReleaseApplication", () => {
  it("takes the latest release BELOW the certificate", () => {
    const got = pickReleaseApplication([app(1), app(3), app(2)], 4);
    expect(got?.application_number).toBe(3);
  });

  it("is strictly below — a release AT this number is not its own baseline", () => {
    // `.lt`, not `.lte`. A release application reading itself would stamp its
    // own completed work as already released and zero out line 5 on the
    // document that is doing the releasing.
    expect(pickReleaseApplication([app(4)], 4)).toBeNull();
  });

  it("ignores a release ABOVE the certificate", () => {
    // Certificate 2 was issued before the release at 5 existed. Reprinting it
    // must reproduce the paper the GC holds, not today's position.
    expect(pickReleaseApplication([app(5)], 2)).toBeNull();
  });

  it("ignores a DRAFT release — nothing has been let go yet", () => {
    expect(pickReleaseApplication([app(2, { status: "draft" })], 4)).toBeNull();
  });

  it("counts a PAID release as well as a submitted one", () => {
    expect(pickReleaseApplication([app(2, { status: "paid" })], 4)?.id).toBe("app-2");
  });

  it("ignores an ordinary application that is not a release", () => {
    expect(pickReleaseApplication([app(2, { is_retainage_release: false })], 4)).toBeNull();
  });

  it("answers a tie the same way every time", () => {
    // The partial unique index should make this unreachable. It is pinned
    // because the two implementations answered it differently when it was
    // unreachable — `limit 1` arbitrarily, a loop by insertion order — and an
    // unreachable disagreement is still a disagreement waiting for a migration.
    const a = { ...app(3), id: "bbb" };
    const b = { ...app(3), id: "aaa" };
    expect(pickReleaseApplication([a, b], 4)?.id).toBe("aaa");
    expect(pickReleaseApplication([b, a], 4)?.id).toBe("aaa");
  });

  it("has nothing to pick from an empty list", () => {
    expect(pickReleaseApplication([], 4)).toBeNull();
  });
});

describe("both money paths read that one rule", () => {
  const src = stripComments(
    readFileSync(join(process.cwd(), "lib/commercial/aia/db.ts"), "utf8")
  );

  /** The body of a top-level function, bounded by the next declaration. */
  function bodyOf(name: string): string {
    const at = src.indexOf(`function ${name}(`);
    expect(at, `${name} is gone from db.ts`).toBeGreaterThan(-1);
    const rest = src.slice(at + 1);
    const next = rest.search(/^(?:export\s+)?(?:async\s+)?(?:function|const|type|interface)\s/m);
    expect(next, `nothing follows ${name} — the slice would run to EOF`).toBeGreaterThan(-1);
    return src.slice(at, at + 1 + next);
  }

  it("the certificate path picks in JS, not in the query", () => {
    const body = bodyOf("listAiaLineItemsWithRelease");
    expect(body).toContain("releaseBaselineFor(");
    // The clauses that moved. Leaving one behind re-creates the second rule in
    // the place it was taken from, and it would agree right up until the
    // shared one changed.
    expect(body, "the selection is back in SQL").not.toMatch(/\.lt\(\s*["']application_number/);
    expect(body, "the ordering is back in SQL").not.toMatch(/\.order\(\s*["']application_number/);
    expect(body, "the status filter is back in SQL").not.toMatch(/\.in\(\s*["']status/);
    // `deleted_at` is the one that stays: a deleted row is not a candidate,
    // and that is the database's job, not the rule's.
    expect(body).toMatch(/\.is\(\s*["']deleted_at["']\s*,\s*null\s*\)/);
  });

  it("the bulk path picks with the same function, over rows already fetched", () => {
    const body = bodyOf("aiaBillingRollupBulk");
    expect(body).toContain("releaseBaselineFor(");
    // It must not re-filter on its way in, or the shared rule is only half the
    // rule and the halves can drift again.
    expect(
      body.match(/status !== "submitted" && \w+\.status !== "paid"/g) ?? [],
      "the bulk path is filtering release status itself again"
    ).toHaveLength(0);
  });

  it("nowhere else in db.ts hand-rolls the same selection", () => {
    // Proves the sweep measured something: `is_retainage_release` appears, and
    // every appearance is either fetching candidates or the shared rule.
    const hits = src.match(/is_retainage_release/g) ?? [];
    expect(hits.length, "is_retainage_release has vanished from db.ts").toBeGreaterThan(0);
    expect(
      src,
      "an application_number comparison next to is_retainage_release is the old rule growing back"
    ).not.toMatch(/is_retainage_release[\s\S]{0,200}application_number\s*[<>]=?\s/);
  });

  it("the Projects list and dashboard read it too — the fourth copy is gone", () => {
    // projects/db.ts hand-rolled the same selection as a loop with no
    // tie-break and no pin, feeding the dashboard tiles and the Projects list.
    const proj = stripComments(
      readFileSync(join(process.cwd(), "lib/commercial/projects/db.ts"), "utf8")
    );
    expect(proj).toContain("releaseBaselineFor(");
    expect(
      proj,
      "a release-vs-certificate number comparison is back in projects/db.ts"
    ).not.toMatch(/application_number\s*>=\s*want\.application_number/);
  });
});
