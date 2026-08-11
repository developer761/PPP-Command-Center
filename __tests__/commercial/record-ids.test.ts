import { describe, it, expect } from "vitest";
import {
  dealNumberRoot,
  opportunityRecordId,
  projectRecordId,
  proposalRecordId,
  workOrderRecordId,
  transactionRecordId,
} from "@/lib/commercial/record-ids";

/**
 * The whole point of this module is that every record on a deal ends in the
 * SAME number (Karan 2026-08). These tests pin that property directly, so a
 * future change to one formatter can't quietly break the family.
 */
describe("shared record IDs", () => {
  const ROOT = "2026-0020";

  it("gives every record on a deal the same trailing number", () => {
    const ids = [
      opportunityRecordId(ROOT),
      projectRecordId(ROOT),
      proposalRecordId(ROOT),
      workOrderRecordId(ROOT),
      transactionRecordId(ROOT),
    ];
    expect(ids).toEqual([
      "OPP-2026-0020",
      "PROJ-2026-0020",
      "PROP-2026-0020",
      "WO-2026-0020",
      "TRANS-2026-0020",
    ]);
    for (const id of ids) expect(id.endsWith(ROOT)).toBe(true);
  });

  it("renders nothing rather than a bare prefix when the deal has no number", () => {
    for (const v of [null, undefined, "", "   "]) {
      expect(opportunityRecordId(v)).toBe("");
      expect(projectRecordId(v)).toBe("");
      expect(proposalRecordId(v)).toBe("");
      expect(workOrderRecordId(v)).toBe("");
      expect(transactionRecordId(v)).toBe("");
    }
  });

  it("is idempotent — an already-prefixed value doesn't double up", () => {
    expect(opportunityRecordId("OPP-2026-0020")).toBe("OPP-2026-0020");
    expect(projectRecordId("OPP-2026-0020")).toBe("PROJ-2026-0020");
    expect(workOrderRecordId("PROJ-2026-0020")).toBe("WO-2026-0020");
    expect(dealNumberRoot("TRANS-2026-0020")).toBe("2026-0020");
  });

  it("leaves the original proposal unsuffixed and tags only real revisions", () => {
    // Karan: no R# until it's been sent and revised — an R1 tag on the
    // original is noise the client shouldn't see.
    expect(proposalRecordId(ROOT, 1)).toBe("PROP-2026-0020");
    expect(proposalRecordId(ROOT, null)).toBe("PROP-2026-0020");
    expect(proposalRecordId(ROOT, 2)).toBe("PROP-2026-0020-R2");
    expect(proposalRecordId(ROOT, 11)).toBe("PROP-2026-0020-R11");
  });

  it("only suffixes a work order when the project actually has several", () => {
    expect(workOrderRecordId(ROOT, 0, 1)).toBe("WO-2026-0020");
    expect(workOrderRecordId(ROOT, 0, 3)).toBe("WO-2026-0020-A");
    expect(workOrderRecordId(ROOT, 1, 3)).toBe("WO-2026-0020-B");
    expect(workOrderRecordId(ROOT, 2, 3)).toBe("WO-2026-0020-C");
  });

  it("never repeats a work-order letter past 26", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const id = workOrderRecordId(ROOT, i, 60);
      expect(seen.has(id), `duplicate at index ${i}: ${id}`).toBe(false);
      seen.add(id);
    }
    expect(workOrderRecordId(ROOT, 25, 60)).toBe("WO-2026-0020-Z");
    expect(workOrderRecordId(ROOT, 26, 60)).toBe("WO-2026-0020-AA");
  });

  it("numbers transactions from 1 and drops the suffix when unpositioned", () => {
    expect(transactionRecordId(ROOT, 1)).toBe("TRANS-2026-0020-1");
    expect(transactionRecordId(ROOT, 12)).toBe("TRANS-2026-0020-12");
    expect(transactionRecordId(ROOT, 0)).toBe("TRANS-2026-0020");
    expect(transactionRecordId(ROOT, null)).toBe("TRANS-2026-0020");
  });
});
