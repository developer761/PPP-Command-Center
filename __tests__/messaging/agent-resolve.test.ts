import { describe, it, expect } from "vitest";
import { resolveAgentConfig, stateOfWorkspace, type AgentConfigLayer } from "@/lib/messaging/agent-resolve";

const GLOBAL: AgentConfigLayer = {
  scope: "global",
  persona_name: "Emily",
  tone_rules: "One question at a time.",
  office_location: "Pasadena",
  service_area_note: "greater Los Angeles",
  confidence_threshold: 0.95,
  autosend: false,
};
const NY: AgentConfigLayer = {
  scope: "state", state_code: "NY",
  office_location: "Garden City",
  service_area_note: "We serve the majority of the area.",
};
const NASSAU: AgentConfigLayer = {
  scope: "workspace", workspace_id: "w1",
  autosend: true,
};

describe("resolveAgentConfig — specificity", () => {
  it("workspace beats state beats global", () => {
    const { value } = resolveAgentConfig([GLOBAL, NY, NASSAU]);
    expect(value.office_location).toBe("Garden City"); // state won
    expect(value.autosend).toBe(true);                 // workspace won
    expect(value.persona_name).toBe("Emily");          // only global had it
  });

  it("sorts layers rather than trusting the order given", () => {
    // Passed backwards, the global default would otherwise beat the workspace.
    const { value } = resolveAgentConfig([NASSAU, NY, GLOBAL]);
    expect(value.office_location).toBe("Garden City");
    expect(value.autosend).toBe(true);
  });

  it("falls back to global when there is no state row", () => {
    // The Pasadena bug: a NY workspace with no state row would answer Pasadena.
    const { value } = resolveAgentConfig([GLOBAL, NASSAU]);
    expect(value.office_location).toBe("Pasadena");
  });

  it("works with only a global layer", () => {
    expect(resolveAgentConfig([GLOBAL]).value.persona_name).toBe("Emily");
  });

  it("returns something usable from no layers at all", () => {
    expect(() => resolveAgentConfig([])).not.toThrow();
  });
});

describe("resolveAgentConfig — null means inherit, empty means blank", () => {
  it("NULL at a lower level inherits rather than clearing", () => {
    const ny: AgentConfigLayer = { scope: "state", state_code: "NY", office_location: null };
    expect(resolveAgentConfig([GLOBAL, ny]).value.office_location).toBe("Pasadena");
  });

  it("an EMPTY STRING deliberately clears an inherited value", () => {
    // A workspace that should answer nothing about its office must be able to
    // say so. Treating empty and absent alike makes that impossible.
    const ws: AgentConfigLayer = { scope: "workspace", workspace_id: "w1", office_location: "" };
    expect(resolveAgentConfig([GLOBAL, ws]).value.office_location).toBe("");
  });

  it("undefined means the column was not selected, and inherits", () => {
    const ws: AgentConfigLayer = { scope: "workspace", workspace_id: "w1" };
    expect(resolveAgentConfig([GLOBAL, ws]).value.office_location).toBe("Pasadena");
  });

  it("false and 0 override, rather than being treated as absent", () => {
    // The classic falsy bug: autosend:false at workspace level must beat
    // autosend:true above it, and a 0 threshold must not silently inherit.
    const on: AgentConfigLayer = { scope: "state", state_code: "NY", autosend: true, confidence_threshold: 0.8 };
    const off: AgentConfigLayer = { scope: "workspace", workspace_id: "w1", autosend: false };
    const { value } = resolveAgentConfig([GLOBAL, on, off]);
    expect(value.autosend).toBe(false);
    expect(value.confidence_threshold).toBe(0.8);
  });
});

describe("resolveAgentConfig — provenance", () => {
  it("says which layer each value came from", () => {
    // So the UI can show "inherited from New York" instead of implying it was
    // set here.
    const { from } = resolveAgentConfig([GLOBAL, NY, NASSAU]);
    expect(from.office_location).toBe("state");
    expect(from.autosend).toBe("workspace");
    expect(from.persona_name).toBe("global");
  });
});

describe("stateOfWorkspace — derived from PPP's own naming", () => {
  it("maps every Phase 1 workspace", () => {
    const cases: [string, string][] = [
      ["NY LI Nassau Leads", "NY"], ["NY LI Suffolk Leads", "NY"],
      ["NY NYC Leads", "NY"], ["NY Queens Leads", "NY"],
      ["NY Wstch Leads", "NY"], ["NY LI Meta", "NY"], ["NYC Meta", "NY"],
      ["NJ Leads", "NJ"], ["NJ Meta", "NJ"],
      ["FL Broward Leads", "FL"], ["FL Miami Leads", "FL"], ["SoFlo Meta", "FL"],
    ];
    for (const [name, expected] of cases) {
      expect(stateOfWorkspace(name), name).toBe(expected);
    }
  });

  it("resolves the AM- prefix to the region behind it", () => {
    expect(stateOfWorkspace("AM - NY")).toBe("NY");
    expect(stateOfWorkspace("AM - SoFlo")).toBe("FL");
    expect(stateOfWorkspace("AM - CA LA")).toBe("CA");
  });

  it("puts WC CT with Connecticut", () => {
    expect(stateOfWorkspace("WC CT Meta")).toBe("CT");
    expect(stateOfWorkspace("CT Leads")).toBe("CT");
  });

  it("an explicit state prefix BEATS a county name", () => {
    // Nassau and Suffolk are counties in Florida and New York both. The first
    // version checked county names first, so this returned NY and would have
    // told a Florida customer the office was in Garden City. No such workspace
    // exists today, which is precisely why it would have gone unnoticed until
    // one did.
    expect(stateOfWorkspace("FL Nassau Leads")).toBe("FL");
    expect(stateOfWorkspace("FL Suffolk Leads")).toBe("FL");
    expect(stateOfWorkspace("CA Queens")).toBe("CA");
    // And with no prefix, the county name still resolves.
    expect(stateOfWorkspace("Nassau Leads")).toBe("NY");
  });

  it("handles the later-phase regions", () => {
    expect(stateOfWorkspace("CA LA Leads")).toBe("CA");
    expect(stateOfWorkspace("CO Denver Leads")).toBe("CO");
    expect(stateOfWorkspace("TX Meta 2")).toBe("TX");
  });

  it("returns null rather than guessing for a source workspace", () => {
    // Google LSA and Thumbtack are national. A wrong state answer here tells a
    // California customer the office is in Garden City.
    expect(stateOfWorkspace("Google LSA")).toBeNull();
    expect(stateOfWorkspace("Thumbtack")).toBeNull();
    expect(stateOfWorkspace("Elevate Paint Co")).toBeNull();
  });
});
