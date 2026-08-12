import { describe, it, expect } from "vitest";
import {
  SAVED_VIEWS,
  activeViewKey,
  viewHref,
  filterChips,
  savedView,
} from "@/lib/commercial/opportunities/saved-views";

const label = (k: string) => ({ proposal: "Proposal", in_progress: "In Progress" })[k] ?? k;

describe("activeViewKey — derived, never declared", () => {
  it("recognises a view from the params alone", () => {
    expect(activeViewKey({ status: "proposal", sort: "oldest" })).toBe("proposals_out");
    expect(activeViewKey({ status: "in_progress" })).toBe("active_projects");
    expect(activeViewKey({})).toBe("all");
  });

  it("stops claiming a view the moment a filter is removed", () => {
    // The reason this is derived rather than a ?view_key= param: remove the
    // proposal chip and a stored key would still say "Proposals out" while the
    // list showed everything.
    expect(activeViewKey({ sort: "oldest" })).toBeNull();
  });

  it("stops claiming a view when an EXTRA filter is added", () => {
    // Hand-narrowing a view is no longer that view. Saying it is would tell
    // someone they are looking at all proposals when they are looking at some.
    expect(activeViewKey({ status: "proposal", sort: "oldest", overdue: "1" })).toBeNull();
  });

  it("ignores params a view does not own, so search never changes the view", () => {
    // Typing in the search box must not knock the page out of "Active projects".
    expect(activeViewKey({ status: "in_progress", q: "hospital" })).toBe("active_projects");
    expect(activeViewKey({ status: "in_progress", view: "kanban" })).toBe("active_projects");
  });

  it("treats an empty string as absent", () => {
    expect(activeViewKey({ status: "", q: "" })).toBe("all");
  });
});

describe("viewHref", () => {
  it("clears the previous view's filters", () => {
    // Switching from Overdue to Active projects must not leave overdue applied
    // — you would pick a view and get a narrower list than it promises.
    const href = viewHref(savedView("active_projects")!, { overdue: "1", sort: "oldest" });
    expect(href).toContain("status=in_progress");
    expect(href).not.toContain("overdue");
    expect(href).not.toContain("sort=oldest");
  });

  it("carries params a view does not own", () => {
    const href = viewHref(savedView("billing")!, { q: "hospital", view: "kanban" });
    expect(href).toContain("q=hospital");
    expect(href).toContain("view=kanban");
  });

  it("round-trips: applying a view makes that view active", () => {
    // The guarantee that the picker and the label can never disagree.
    for (const v of SAVED_VIEWS) {
      const href = viewHref(v, { q: "x" });
      const params = Object.fromEntries(new URLSearchParams(href.split("?")[1] ?? ""));
      expect(activeViewKey(params), v.key).toBe(v.key);
    }
  });
});

describe("filterChips", () => {
  it("shows what is narrowing the list and removes exactly one", () => {
    const chips = filterChips({ status: "proposal", overdue: "1", q: "hospital" }, label);
    expect(chips.map((c) => c.key).sort()).toEqual(["overdue", "q", "status"]);
    const removeStatus = chips.find((c) => c.key === "status")!.removeHref;
    expect(removeStatus).not.toContain("status=");
    // …and leaves the others alone.
    expect(removeStatus).toContain("overdue=1");
    expect(removeStatus).toContain("q=hospital");
  });

  it("removes one source without dropping the rest", () => {
    const chips = filterChips({ sources: "gc_invite,public_bid" }, label);
    const drop = chips.find((c) => c.key === "source:gc_invite")!.removeHref;
    expect(drop).toContain("sources=public_bid");
    expect(drop).not.toContain("gc_invite");
  });

  it("returns nothing when nothing is filtered", () => {
    expect(filterChips({ view: "kanban", sort: "recent" }, label)).toEqual([]);
  });
});

describe("the view set itself", () => {
  it("has unique keys and every view is reachable from the picker", () => {
    const keys = SAVED_VIEWS.map((v) => v.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const v of SAVED_VIEWS) {
      expect(["pipeline", "delivery", "attention"], v.key).toContain(v.group);
      // Every view explains itself — a picker of bare labels is a guessing game.
      expect(v.hint.length, v.key).toBeGreaterThan(10);
    }
  });
});
