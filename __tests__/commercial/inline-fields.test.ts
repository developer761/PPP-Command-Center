import { describe, it, expect } from "vitest";
import { INLINE_FIELDS, inlineField, parseInlineValue } from "@/lib/commercial/opportunities/inline-fields";

/**
 * The allowlist is a SECURITY BOUNDARY, not a convenience. The inline writer
 * takes a field name from the request, so anything reachable here is writable
 * by anyone who can post the form.
 */
describe("INLINE_FIELDS — what the pencil may write", () => {
  it("refuses the columns that have their own writers", () => {
    // status/sub_status cascade to proposals, stamp decided_at and create the
    // project; decided_at is derived; accepted_contract_cents is the signed
    // contract. A bare column write skips all of that.
    for (const forbidden of [
      "status", "sub_status", "decided_at", "closed_out_at",
      "accepted_contract_cents", "accepted_contract_proposal_id",
      "project_number", "account_id", "deleted_at", "archived_at",
    ]) {
      expect(inlineField(forbidden), forbidden).toBeUndefined();
    }
  });

  it("allows the fields people actually retype", () => {
    for (const ok of ["title", "proposal_due_at", "rfp_received_at", "property_city"]) {
      expect(inlineField(ok), ok).toBeDefined();
    }
  });

  it("has no duplicate names", () => {
    const names = INLINE_FIELDS.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("parseInlineValue", () => {
  const f = (n: string) => inlineField(n)!;

  it("treats an emptied field as a clear, not an error", () => {
    // Otherwise the only way to blank a field is select-all-delete-save, and
    // people reasonably assume that won't work.
    expect(parseInlineValue(f("title"), "   ")).toEqual({ value: null });
  });

  it("keeps a bad date out of a column every elapsed-time figure reads", () => {
    expect(parseInlineValue(f("proposal_due_at"), "next tuesday")).toHaveProperty("error");
    expect(parseInlineValue(f("proposal_due_at"), "08/20/2026")).toHaveProperty("error");
    expect(parseInlineValue(f("proposal_due_at"), "2026-08-20")).toEqual({ value: "2026-08-20" });
  });

  it("bounds probability to a percentage", () => {
    expect(parseInlineValue(f("probability_pct"), "140")).toHaveProperty("error");
    expect(parseInlineValue(f("probability_pct"), "-5")).toHaveProperty("error");
    expect(parseInlineValue(f("probability_pct"), "abc")).toHaveProperty("error");
    expect(parseInlineValue(f("probability_pct"), "65")).toEqual({ value: 65 });
    // Rounds rather than rejecting — a typed "62.5" is a clear intent.
    expect(parseInlineValue(f("probability_pct"), "62.5")).toEqual({ value: 63 });
  });

  it("normalises state to two upper-case letters", () => {
    expect(parseInlineValue(f("property_state"), "ny")).toEqual({ value: "NY" });
    expect(parseInlineValue(f("property_state"), "New York")).toHaveProperty("error");
  });

  it("refuses an over-long paste rather than silently truncating it", () => {
    // People paste whole emails into Title. Truncating loses data without
    // saying so; refusing tells them.
    const long = "x".repeat(500);
    expect(parseInlineValue(f("title"), long)).toHaveProperty("error");
  });

  it("trims, so a stray space is not stored as a value", () => {
    expect(parseInlineValue(f("client_name"), "  Acme  ")).toEqual({ value: "Acme" });
  });
});
