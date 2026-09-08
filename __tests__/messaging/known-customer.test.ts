import { describe, it, expect } from "vitest";
import { knownCustomerPrompt, knownFields, displayPhone } from "@/lib/messaging/known-customer";
import { validateAction } from "@/lib/messaging/agent-output";
import { buildSystemPrompt, type AgentConfigForRun } from "@/lib/messaging/agent-run";
import { renderMessage } from "@/lib/messaging/render";

const CFG: AgentConfigForRun = {
  persona_name: "Emily", persona_role: "assistant",
  required_flow: ["project_details", "full_address"],
  services_included: null, services_excluded: null, offsite_rules: null,
  tone_rules: null, office_location: null, service_area_note: null,
  confidence_threshold: 0.95,
};

const KNOWN = {
  name: "Tom",
  phone: "+15167846046",
  email: "tomrvc@example.com",
  address: "166 S Park Ave, Rockville Centre, NY 11570",
  inquiryScope: "1500sqft Cape Cod, cedar shake cleaned and scraped, 2 coats exterior",
};

/** All four of these come from Kate's graded conversations, 2026-09-08. */
describe("the bot must not ask for what it already has", () => {
  it('never asks for the number it is texting on — Kate\'s ":skull:"', () => {
    const p = buildSystemPrompt(CFG, [], "new_lead", KNOWN);
    expect(p).toMatch(/NEVER ask for it/);
    expect(p).toMatch(/never ask them to type it out/i);
    expect(p).toContain("(516) 784-6046");
  });

  it("says so even when we hold nothing else — we always have the handset", () => {
    const p = buildSystemPrompt(CFG, [], "new_lead", {});
    expect(p).toMatch(/already have their phone number/i);
  });

  it("refuses ask_address once an address is on file", () => {
    const res = validateAction(
      { intent: "ask_address", freeText: "", confidence: 0.99, reasoning: "" },
      { knownFields: { address: true } }
    );
    expect(res.ok).toBe(false);
  });

  it("allows ask_address when there genuinely is none — the control", () => {
    const res = validateAction(
      { intent: "ask_address", freeText: "", confidence: 0.99, reasoning: "" },
      { knownFields: { address: false } }
    );
    expect(res.ok).toBe(true);
  });

  it("refuses ask_project_details once the enquiry scope is on file", () => {
    const res = validateAction(
      { intent: "ask_project_details", freeText: "", confidence: 0.9, reasoning: "" },
      { knownFields: { inquiryScope: true } }
    );
    expect(res.ok).toBe(false);
  });

  it("cannot confirm something we do not hold", () => {
    const res = validateAction(
      { intent: "confirm_address", freeText: "", confidence: 0.99, reasoning: "" },
      { knownFields: { address: false } }
    );
    expect(res.ok).toBe(false);
  });

  it("reads the address back instead of asking for it", () => {
    const out = renderMessage({ intent: "confirm_address", known: { address: KNOWN.address } });
    expect(out).toContain("166 S Park Ave");
    expect(out).toMatch(/correct address|right address/i);
  });

  it("quotes the scope back — Kate's merge-field request", () => {
    const out = renderMessage({ intent: "confirm_scope", known: { scope: KNOWN.inquiryScope } });
    expect(out).toContain("Cape Cod");
  });

  it("confirms both contact details in one message, as Emily does well", () => {
    const out = renderMessage({
      intent: "confirm_contact",
      known: { phone: "516-784-6046", email: "tomrvc@example.com" },
    });
    expect(out).toContain("516-784-6046");
    expect(out).toContain("tomrvc@example.com");
  });

  it("sends nothing rather than a message containing {address}", () => {
    expect(renderMessage({ intent: "confirm_address", known: {} })).toBe("");
    expect(renderMessage({ intent: "confirm_address" })).not.toContain("{");
  });

  it("formats the number for a human, not as E.164", () => {
    expect(displayPhone("+15167846046")).toBe("(516) 784-6046");
    expect(knownFields({ phone: "+15167846046" }).phone).toBe("(516) 784-6046");
  });

  it("treats blank and whitespace as not known", () => {
    const f = knownFields({ address: "   ", email: "" });
    expect(f.address).toBeNull();
    expect(f.email).toBeNull();
  });

  it("warns the model to announce a phone quote before switching to one", () => {
    const p = buildSystemPrompt(CFG, [], "new_lead", KNOWN);
    expect(p).toMatch(/BEFORE SWITCHING TO A PHONE QUOTE/);
    expect(p).toMatch(/confirm their contact details/i);
  });
});
