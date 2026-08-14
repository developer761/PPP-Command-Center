import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const ACCOUNT_PAGE = "app/commercial/accounts/[id]/page.tsx";
const SIDEBAR = "components/commercial-sidebar.tsx";

/**
 * Two bugs of the same shape: a pair of lines, each individually correct,
 * that are only wrong together — and far enough apart that nobody reading
 * either one would notice.
 */

describe("deal drill-in forwarding (?tab=projects&project=<uuid>)", () => {
  /**
   * The account page carries a ~20-line block that forwards the OLD in-account
   * deal drill-in URL to the deal's own page. Those URLs are in bookmarks, bell
   * notifications and sent emails.
   *
   * `resolveTabParam` aliases `projects` → `deals`, so the resolved tab can
   * never BE "projects". Keying the forward on the resolved value made the
   * condition permanently false and the whole block dead: every one of those
   * links quietly landed on the account's deal LIST instead of the deal it
   * named. Both lines are right; only the pair is wrong.
   */
  it("keys on the RAW tab param, because the resolved one is aliased away", () => {
    const src = read(ACCOUNT_PAGE);
    const at = src.indexOf("const inDealDrillIn");
    expect(at, "no inDealDrillIn").toBeGreaterThan(-1);
    const line = src.slice(at, src.indexOf(";", at));
    expect(line, "must read the raw ?tab= value").toContain("rawTab");
    expect(
      /\btab === "projects"/.test(line),
      "keyed on the RESOLVED tab, which resolveTabParam aliases to 'deals' — the forward is dead code"
    ).toBe(false);
  });

  it("the alias that makes the above necessary is still there", () => {
    // If someone stops aliasing `projects`, the raw-vs-resolved distinction
    // stops mattering — but this test should then be revisited deliberately
    // rather than silently passing for a new reason.
    const src = read(ACCOUNT_PAGE);
    expect(src).toContain(`if (raw === "projects") return { primary: "deals"`);
  });

  it("still actually forwards", () => {
    const src = read(ACCOUNT_PAGE);
    const at = src.indexOf("if (inDealDrillIn) {");
    expect(at, "the forwarding block is gone").toBeGreaterThan(-1);
    expect(src.slice(at, at + 1400)).toContain("redirect(`/commercial/opportunities/");
  });
});

describe("sidebar active-row override", () => {
  /**
   * `isActive` short-circuits to `href === activeOverride`. The override
   * targets (/commercial/proposals and the /commercial/post-job/* indexes) were
   * removed from the nav in the restructure, so the comparison failed for every
   * row at once and NOTHING highlighted — open a proposal editor or any
   * post-sale tool and the sidebar went completely dark.
   */
  it("only applies an override that points at a row the sidebar renders", () => {
    const src = read(SIDEBAR);
    expect(src, "override is not validated against the rendered rows").toContain(
      "renderedHrefs.has(wantedOverride)"
    );
    // And the short-circuit must be reading the VALIDATED value, not the raw one.
    const at = src.indexOf("const isActive");
    const body = src.slice(at, at + 320);
    expect(body).toContain("if (activeOverride) return href === activeOverride");
    expect(
      body.includes("wantedOverride"),
      "isActive reads the unvalidated override"
    ).toBe(false);
  });

  it("the override targets really are absent from the nav — this is not hypothetical", () => {
    const src = read(SIDEBAR);
    const navStart = src.indexOf("const navSections");
    const navEnd = src.indexOf("\nexport ", navStart) === -1 ? src.length : src.indexOf("\nexport ", navStart);
    const nav = src.slice(navStart, navEnd);
    // If either of these comes BACK into the nav, the fallback stops being
    // exercised and the override starts working again — which is the intended
    // self-healing behaviour, so this test documents the current state rather
    // than pinning it.
    const proposalsInNav = nav.includes(`href: "/commercial/proposals"`);
    const postJobInNav = /href: "\/commercial\/post-job\//.test(nav);
    expect(
      proposalsInNav && postJobInNav,
      "both override targets are back in the nav — revisit the fallback"
    ).toBe(false);
  });
});
