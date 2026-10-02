import { describe, it, expect } from "vitest";
import {
  buildNumberImportPreview, toNumberAssignments, type KnownWorkspace,
} from "@/lib/messaging/number-import";

/**
 * The failure this importer exists to make impossible is not a bad file. It
 * is a SILENT MISROUTE: a workspace holding the wrong number sends from an
 * area code its customers do not recognise and the replies land in another
 * region's queue, and two workspaces holding the SAME number cannot attribute
 * inbound at all. verify-port-readiness asserts both; these refuse both before
 * the write.
 */
const WORKSPACES: KnownWorkspace[] = [
  { id: "w-nassau", name: "NY LI Nassau Leads", phoneE164: "+15163448418" },
  { id: "w-queens", name: "NY Queens Leads", phoneE164: "+13476577035" },
  { id: "w-new", name: "NY Wstch Leads", phoneE164: null },
];

const csv = (body: string) => `workspace,number\n${body}`;

describe("reading the file", () => {
  it("resolves a workspace by name and normalises the number", () => {
    const p = buildNumberImportPreview(csv("NY Wstch Leads,(914) 415-6860"), WORKSPACES);
    expect(p.usable).toBe(1);
    expect(p.rows[0].workspaceId).toBe("w-new");
    expect(p.rows[0].phoneE164).toBe("+19144156860");
  });

  it.each([
    ["+1 914 415 6860"],
    ["914-415-6860"],
    ["9144156860"],
    ["(914) 415-6860 ext 22"],
  ])("accepts %j, the way a person pastes it", (written) => {
    const p = buildNumberImportPreview(csv(`NY Wstch Leads,${written}`), WORKSPACES);
    expect(p.rows[0].phoneE164, written).toBe("+19144156860");
  });

  it("matches a workspace name regardless of case and spacing", () => {
    const p = buildNumberImportPreview(csv("  ny li  NASSAU leads ,5163448418"), WORKSPACES);
    expect(p.rows[0].workspaceId).toBe("w-nassau");
  });

  it("ignores a blank line rather than calling it a problem", () => {
    const p = buildNumberImportPreview(csv("NY Wstch Leads,9144156860\n,\n"), WORKSPACES);
    expect(p.rows).toHaveLength(1);
    expect(p.unusable).toBe(0);
  });
});

describe("what it refuses", () => {
  it("refuses a workspace it does not know", () => {
    const p = buildNumberImportPreview(csv("NY Long Island,9144156860"), WORKSPACES);
    expect(p.rows[0].problem).toMatch(/no workspace called/i);
  });

  it("refuses a number it cannot read", () => {
    const p = buildNumberImportPreview(csv("NY Wstch Leads,not a number"), WORKSPACES);
    expect(p.rows[0].problem).toMatch(/not a usable phone number/i);
  });

  it("refuses a number outside the US", () => {
    const p = buildNumberImportPreview(csv("NY Wstch Leads,+442071234567"), WORKSPACES);
    expect(p.rows[0].problem).toMatch(/not a US number/i);
  });

  /** The two properties verify-port-readiness asserts. */
  it("refuses a number another workspace already holds", () => {
    const p = buildNumberImportPreview(csv("NY Wstch Leads,5163448418"), WORKSPACES);
    expect(p.rows[0].problem).toMatch(/already belongs to NY LI Nassau Leads/i);
  });

  it("refuses the same number claimed twice in one file", () => {
    const p = buildNumberImportPreview(
      csv("NY Wstch Leads,9144156860\nNY Queens Leads,9144156860"), WORKSPACES);
    expect(p.rows[0].problem).toBeNull();
    expect(p.rows[1].problem).toMatch(/already claimed on line 2/i);
  });

  it("refuses one workspace set twice in one file", () => {
    const p = buildNumberImportPreview(
      csv("NY Wstch Leads,9144156860\nNY Wstch Leads,9292223333"), WORKSPACES);
    expect(p.rows[1].problem).toMatch(/already set on line 2/i);
  });

  /**
   * A SWAP IS LEGAL, and refusing it would make the importer useless for the
   * case it is most needed in — two regions handed each other's numbers.
   * Allowed only because the holder's own row moves them off it in the same
   * file, so the end state still has no number on two workspaces.
   */
  it("allows a reassignment when the current holder is moved in the same file", () => {
    const p = buildNumberImportPreview(
      csv("NY Wstch Leads,5163448418\nNY LI Nassau Leads,9144156860"), WORKSPACES);
    expect(p.rows[0].problem).toBeNull();
    expect(p.rows[1].problem).toBeNull();
    expect(p.usable).toBe(2);
  });

  it("still refuses it when the holder's row keeps the same number", () => {
    const p = buildNumberImportPreview(
      csv("NY Wstch Leads,5163448418\nNY LI Nassau Leads,5163448418"), WORKSPACES);
    expect(p.rows[0].problem).toMatch(/already belongs to/i);
  });
});

describe("what the preview tells somebody before they commit", () => {
  it("counts a change to a number already held as replacing", () => {
    const p = buildNumberImportPreview(csv("NY Queens Leads,9292223333"), WORKSPACES);
    expect(p.replacing).toBe(1);
    expect(p.unchanged).toBe(0);
    expect(p.rows[0].currentPhone).toBe("+13476577035");
  });

  it("counts a row that sets what is already there as unchanged", () => {
    const p = buildNumberImportPreview(csv("NY Queens Leads,3476577035"), WORKSPACES);
    expect(p.unchanged).toBe(1);
    expect(p.replacing).toBe(0);
  });

  it("does not write the no-ops", () => {
    const p = buildNumberImportPreview(
      csv("NY Queens Leads,3476577035\nNY Wstch Leads,9144156860"), WORKSPACES);
    expect(toNumberAssignments(p)).toEqual([
      { workspaceId: "w-new", phoneE164: "+19144156860" },
    ]);
  });

  it("writes nothing from a file where every row has a problem", () => {
    const p = buildNumberImportPreview(csv("Nowhere,123"), WORKSPACES);
    expect(toNumberAssignments(p)).toEqual([]);
  });

  it("reports which headers it found, so a wrong column is visible", () => {
    const p = buildNumberImportPreview("region,did\nNY Wstch Leads,9144156860", WORKSPACES);
    expect(p.detectedHeaders).toEqual({ workspace: "region", number: "did" });
    expect(p.usable).toBe(1);
  });
});
