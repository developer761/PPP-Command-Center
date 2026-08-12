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

  it("no longer exposes the fields Brendan asked us to drop", () => {
    // Probability ("I don't use this. Not sure what this is.") and the proposed
    // start/end dates ("too early to determine at the opportunity level").
    // Leaving any of them inline-editable would quietly reintroduce a field the
    // forms just removed.
    for (const gone of ["probability_pct", "proposed_start_at", "proposed_end_at"]) {
      expect(inlineField(gone), gone).toBeUndefined();
    }
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

/**
 * The structural guard the parallel session asked for.
 *
 * The recurring failure all day: a field is removed from a FORM, and the server
 * action keeps reading it. `formData.get` returns null when a field is absent
 * and "" when it is present-but-empty — collapsing both to null turns "I
 * removed the input" into "every save wipes the stored value". It happened to
 * the proposed dates and nearly to probability, whose value the dashboard
 * forecast reads.
 *
 * This pins the distinction the actions must preserve.
 */
describe("absent form field vs empty form field", () => {
  it("an EMPTY field is a clear — an intentional edit", () => {
    // Present-but-blank means "I want this gone".
    const f = inlineField("client_name")!;
    expect(parseInlineValue(f, "")).toEqual({ value: null });
    expect(parseInlineValue(f, "   ")).toEqual({ value: null });
  });

  it("distinguishes null (absent) from empty string (present) in FormData", () => {
    // The exact API behaviour every server action here depends on. If this ever
    // stops being true, the actions that branch on `=== null` are silently
    // writing nulls again.
    const fd = new FormData();
    fd.set("present_but_empty", "");
    expect(fd.get("present_but_empty")).toBe("");
    expect(fd.get("not_on_the_form")).toBeNull();
    // …which is why `?? ""` before the null-check is the bug: it erases the
    // difference the branch depends on.
    expect(String(fd.get("not_on_the_form") ?? "")).toBe("");
  });
});
