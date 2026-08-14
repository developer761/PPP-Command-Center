import { describe, it, expect } from "vitest";
import { safeBack, withBack } from "@/lib/commercial/submittals/back-url";

/**
 * Round-3 handoff #1: after any action on a submittal (add an item, save the
 * cover letter), the user was ejected to the submittals LIST because withBack
 * redirected to a deal-origin `back` verbatim instead of to the action's own
 * `url` (the detail page). These tests pin the corrected rule: an action
 * redirect ALWAYS lands on `url`, with `back` carried as a `?back=` param.
 */

const DETAIL = "/commercial/accounts/acc-1/submittals/opp-1/sub-1";
const DEAL_DRILL_IN =
  "/commercial/accounts/11111111-1111-1111-1111-111111111111?tab=projects&project=22222222-2222-2222-2222-222222222222";
const DEAL_PAGE = "/commercial/opportunities/33333333-3333-3333-3333-333333333333";
const GLOBAL_INDEX = "/commercial/submittals";

describe("withBack — action redirects stay on the detail page", () => {
  it("keeps the user on the detail page when the origin is a deal drill-in", () => {
    const out = withBack(DETAIL, DEAL_DRILL_IN);
    // The regression: out used to START with the deal drill-in, ejecting to the list.
    expect(out.startsWith(DETAIL)).toBe(true);
    expect(out).toBe(`${DETAIL}?back=${encodeURIComponent(DEAL_DRILL_IN)}`);
    // Back is preserved so the Back button still returns to the deal.
    expect(decodeURIComponent(out.split("back=")[1])).toBe(DEAL_DRILL_IN);
  });

  it("keeps the user on the detail page when the origin is the deal's own page", () => {
    const out = withBack(DETAIL, DEAL_PAGE);
    expect(out.startsWith(DETAIL)).toBe(true);
    expect(out).toBe(`${DETAIL}?back=${encodeURIComponent(DEAL_PAGE)}`);
  });

  it("preserves an existing query flag on the url (e.g. ?saved=1) and appends back with &", () => {
    const out = withBack(`${DETAIL}?saved=1`, DEAL_DRILL_IN);
    expect(out).toBe(`${DETAIL}?saved=1&back=${encodeURIComponent(DEAL_DRILL_IN)}`);
  });

  it("carries a global-index origin the same way", () => {
    const out = withBack(DETAIL, GLOBAL_INDEX);
    expect(out).toBe(`${DETAIL}?back=${encodeURIComponent(GLOBAL_INDEX)}`);
  });

  it("is a no-op with no back context", () => {
    expect(withBack(DETAIL, null)).toBe(DETAIL);
  });
});

describe("safeBack — open-redirect guard", () => {
  it("honours a relative /commercial/ path", () => {
    expect(safeBack(DEAL_DRILL_IN)).toBe(DEAL_DRILL_IN);
    expect(safeBack(GLOBAL_INDEX)).toBe(GLOBAL_INDEX);
  });

  it("rejects absolute and off-site origins", () => {
    expect(safeBack("https://evil.example/commercial/x")).toBe(null);
    expect(safeBack("/dashboard/materials")).toBe(null);
    expect(safeBack("")).toBe(null);
    expect(safeBack(null)).toBe(null);
    expect(safeBack(undefined)).toBe(null);
  });
});
