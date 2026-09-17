import { describe, it, expect } from "vitest";

import { onRoute } from "@/components/commercial/onboarding-walkthrough";

/**
 * A walkthrough step has to actually land on its page.
 *
 * The bug this pins was invisible to every other check and obvious the moment
 * somebody used it. Every accounting step routes to the same PATH with a
 * different query — `/commercial/accounting?view=receivables` — and the engine
 * compared `usePathname()`, which is the path alone, against the whole route
 * string. They were never equal, so it pushed and then, because the pathname
 * had not changed, never re-ran to go and find the target. What Karan saw was a
 * card reading "Date received · 4 of 6" over whatever tab he happened to be on,
 * with nothing highlighted. Thirteen of Mary's steps behaved that way.
 *
 * Pure, so the rule can be tested without a router.
 */
const params = (q: string) => new URLSearchParams(q);

describe("a step knows whether it has arrived", () => {
  it("is not arrived when the query has not been applied yet", () => {
    // THE BUG. Same path, and the tab is wrong — it must still navigate.
    expect(onRoute("/commercial/accounting?view=receivables", "/commercial/accounting", params(""))).toBe(false);
  });

  it("is arrived once the query matches", () => {
    expect(
      onRoute("/commercial/accounting?view=receivables", "/commercial/accounting", params("view=receivables"))
    ).toBe(true);
  });

  it("is not arrived on a different tab of the same page", () => {
    expect(
      onRoute("/commercial/accounting?view=purchases", "/commercial/accounting", params("view=receivables"))
    ).toBe(false);
  });

  it("handles a plain route with no query", () => {
    expect(onRoute("/commercial", "/commercial", params(""))).toBe(true);
    expect(onRoute("/commercial", "/commercial/accounting", params(""))).toBe(false);
  });

  it("ignores extra params already on the URL", () => {
    // Somebody's filter is not a reason to navigate away and lose it — and a
    // re-push on every render is an infinite loop, not a cosmetic issue.
    expect(
      onRoute(
        "/commercial/accounting?view=receivables",
        "/commercial/accounting",
        params("view=receivables&q=alta&sort=age")
      )
    ).toBe(true);
  });

  it("does not care what order the params are in", () => {
    expect(
      onRoute(
        "/commercial/opportunities/abc?tab=project&sub=aia",
        "/commercial/opportunities/abc",
        params("sub=aia&tab=project")
      )
    ).toBe(true);
  });

  it("matches the job-tab routes the guide actually uses", () => {
    const id = "cca62d04-6006-4b8e-851a-29294951f0a6";
    expect(onRoute(`/commercial/opportunities/${id}?tab=proposals`, `/commercial/opportunities/${id}`, params("tab=proposals"))).toBe(true);
    expect(onRoute(`/commercial/opportunities/${id}?tab=proposals`, `/commercial/opportunities/${id}`, params("tab=docs"))).toBe(false);
  });
});
