import { describe, it, expect } from "vitest";
import { STANDARD_SURFACES, ORPHAN_SURFACES, classifySurface } from "@/lib/customer-form/surface-mapping";

/**
 * WorkOrderLineItem.Surfaces__c is a RESTRICTED multipicklist, verified against
 * the live org on 2026-08-19. Salesforce will not accept a value outside this
 * list, which is what makes hardcoding the orphan set safe.
 *
 * That safety is conditional. The submit route silently skips any surface it
 * classifies as "unknown" — so if someone adds a picklist value in Salesforce
 * and doesn't add it here, the form will happily show the surface, the customer
 * will pick a colour for it, and the submit will drop it on the floor with no
 * error on either end. This test is the tripwire for that.
 */
const SF_PICKLIST = [
  "Walls", "Ceiling", "Trim", "Floor",
  "Accent Wall", "Cabinets", "Door", "Window", "Closet", "Shelves",
] as const;

describe("Surfaces__c picklist coverage", () => {
  it("classifies every live picklist value as standard or orphan — never unknown", () => {
    const unknown = SF_PICKLIST.filter((s) => classifySurface(s).kind === "unknown");
    expect(
      unknown,
      "these would be silently dropped on submit — add them to ORPHAN_SURFACES"
    ).toEqual([]);
  });

  it("splits them the way the Salesforce schema does", () => {
    // Only these four have dedicated Color/Finish fields on the WOLI. The rest
    // share the single ColorOther__c slot, which is why 2+ of them overflow
    // into ColorNotes__c.
    expect([...STANDARD_SURFACES]).toEqual(["Walls", "Ceiling", "Trim", "Floor"]);
    const orphans = SF_PICKLIST.filter((s) => classifySurface(s).kind === "orphan");
    expect(orphans).toEqual(["Accent Wall", "Cabinets", "Door", "Window", "Closet", "Shelves"]);
  });

  it("is case- and singular-tolerant, since these labels are matched as text", () => {
    expect(classifySurface("CABINETS").kind).toBe("orphan");
    expect(classifySurface(" cabinet ").kind).toBe("orphan");
    expect(ORPHAN_SURFACES.has("other")).toBe(true);
  });
});
