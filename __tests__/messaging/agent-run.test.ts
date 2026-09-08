import { describe, it, expect } from "vitest";
import { buildSystemPrompt, agentAvailable, type AgentConfigForRun } from "@/lib/messaging/agent-run";

const cfg: AgentConfigForRun = {
  persona_name: "Emily",
  persona_role: "the team's assistant",
  required_flow: ["project_details", "full_address", "contact_information", "appointment_availability"],
  services_included: "Interior and exterior painting, cabinets, decks.",
  services_excluded: "Bathtubs, appliances, vehicles, murals.",
  offsite_rules: "Required when the customer has no access to the property.",
  tone_rules: "One question at a time. No em dashes.",
  office_location: "Garden City",
  service_area_note: "We serve the majority of the area.",
  confidence_threshold: 0.95,
};

describe("buildSystemPrompt — assembled from config, not hard-coded", () => {
  it("carries the persona and the ordered flow", () => {
    const p = buildSystemPrompt(cfg, []);
    expect(p).toContain("You are Emily, the team's assistant");
    expect(p).toMatch(/1\. project details[\s\S]*2\. full address[\s\S]*3\. contact information[\s\S]*4\. appointment availability/);
  });

  it("states the two prohibitions in the opening paragraph", () => {
    // Price and appointment times are the two things Emily's own prompt is
    // most emphatic about, and they are the two the post-filter also blocks.
    const p = buildSystemPrompt(cfg, []);
    expect(p).toContain("never quote a price");
    expect(p).toContain("never offer an appointment time");
  });

  it("uses the office and service area it was given", () => {
    // The point of the state tier. A NY workspace must not say Pasadena.
    const p = buildSystemPrompt(cfg, []);
    expect(p).toContain("Garden City");
    expect(p).not.toContain("Pasadena");
  });

  it("changes when the config changes, without touching this file", () => {
    const la = buildSystemPrompt({ ...cfg, office_location: "Pasadena" }, []);
    expect(la).toContain("Pasadena");
    expect(la).not.toContain("Garden City");
  });

  it("includes Kate's hard nos under an unmissable heading", () => {
    const p = buildSystemPrompt(cfg, ["promise a lifetime warranty", "discuss financing"]);
    expect(p).toContain("NEVER, under any circumstances");
    expect(p).toContain("- promise a lifetime warranty");
    expect(p).toContain("- discuss financing");
  });

  it("omits the hard-no section entirely when there are none", () => {
    // An empty "NEVER:" heading reads as though the list was lost.
    expect(buildSystemPrompt(cfg, [])).not.toContain("NEVER, under any circumstances");
  });

  it("tells it to escalate when unsure, and says why", () => {
    // The confidence gate only works if the model is willing to use it.
    const p = buildSystemPrompt(cfg, []);
    expect(p).toContain("escalate");
    expect(p).toContain("costs far less than a wrong answer");
  });

  it("survives a config with everything optional missing", () => {
    const bare: AgentConfigForRun = {
      ...cfg, services_included: null, services_excluded: null,
      offsite_rules: null, tone_rules: null, office_location: null, service_area_note: null,
    };
    const p = buildSystemPrompt(bare, []);
    expect(p).toContain("Emily");
    expect(p).not.toContain("null");
    expect(p).not.toContain("undefined");
  });
});

describe("agentAvailable", () => {
  it("reports honestly on whether a key is configured", () => {
    // Same shape as briefAvailable() in the commercial reports — no key means
    // the feature says so rather than failing at call time.
    expect(agentAvailable()).toBe(!!process.env.ANTHROPIC_API_KEY);
  });
});
