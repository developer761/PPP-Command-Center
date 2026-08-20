import { describe, it, expect } from "vitest";
import {
  SAVED_VIEWS,
  savedViewHref,
  activeViewKey,
  VIEW_OWNED_PARAMS,
} from "@/lib/commercial/opportunities/saved-views";

/**
 * A saved view is DERIVED, not declared.
 *
 * `activeViewKey` reads the params actually applied and works out which view
 * that is. So a link to a view has to carry the view's real params — and the
 * one thing it must never carry is a `?view=<key>`, because `view` is the
 * display toggle (list / customer / sheet) and an unknown value there falls
 * through to the default, silently showing the WHOLE pipeline.
 *
 * That is exactly what shipped: seven retired Post-Job pages redirected to
 * `?view=billing` and friends, and every one landed unfiltered. Nothing threw.
 * The round-trip below is the invariant that catches it.
 */
describe("savedViewHref", () => {
  it("round-trips: the href it builds reads back as the view it was asked for", () => {
    for (const view of SAVED_VIEWS) {
      const href = savedViewHref(view.key);
      const params = Object.fromEntries(new URLSearchParams(href.split("?")[1] ?? ""));
      expect(activeViewKey(params), `view "${view.key}" does not round-trip`).toBe(view.key);
    }
  });

  it("never emits ?view= — that param is the display toggle, not the view", () => {
    // The whole bug in one assertion. `view=billing` is not a display mode, so
    // it resolves to the default sheet and applies no filter at all.
    for (const view of SAVED_VIEWS) {
      const params = new URLSearchParams(savedViewHref(view.key).split("?")[1] ?? "");
      expect(params.has("view"), `"${view.key}" emitted a ?view= param`).toBe(false);
    }
  });

  it("only emits params a view is allowed to own", () => {
    // Anything outside VIEW_OWNED_PARAMS survives a view switch, so a view that
    // set one would leak its filter into every view chosen after it.
    for (const view of SAVED_VIEWS) {
      const params = new URLSearchParams(savedViewHref(view.key).split("?")[1] ?? "");
      for (const k of params.keys()) {
        expect(VIEW_OWNED_PARAMS as readonly string[], `"${view.key}" sets "${k}"`).toContain(k);
      }
    }
  });

  it("refuses a key that doesn't exist instead of returning a bare list URL", () => {
    // @ts-expect-error — deliberately off the union; the throw is the runtime half.
    expect(() => savedViewHref("no_such_view")).toThrow(/Unknown saved view/);
  });

  it("'All open' is the bare list — it owns no params", () => {
    expect(savedViewHref("all")).toBe("/commercial/opportunities");
  });
});
