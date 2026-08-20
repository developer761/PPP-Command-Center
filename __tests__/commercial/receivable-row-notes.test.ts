import { describe, it, expect } from "vitest";
import {
  rowsNeedingNotes,
  withDraftedNotes,
  AI_NOTE_MARK,
} from "@/lib/commercial/reports/receivables-row-notes";
import { summarizeReceivables, type ReceivableRow } from "@/lib/commercial/reports/receivables";
import { receivablesCsv } from "@/lib/commercial/reports/receivables-export";

/**
 * Drafted notes fill the silence on a chase sheet — they never overwrite a
 * person.
 *
 * That contract is the whole thing. Mary's column is the most valuable part of
 * the receivables sheet; a draft that could quietly replace or impersonate one
 * of her notes would cost more than the empty rows ever did.
 */

function row(over: Partial<ReceivableRow> = {}): ReceivableRow {
  return {
    kind: "invoice",
    key: "invoice:1",
    sourceId: "1",
    accountId: "a1",
    accountName: "Acme GC",
    opportunityId: "o1",
    jobName: "Panera — Holbrook",
    openCents: 100_00,
    reference: "INV-1",
    note: null,
    issuedIso: "2026-08-10T16:00:00Z",
    daysOut: null,
    href: "/x",
    billingHref: "/y",
    ...over,
  };
}

describe("rowsNeedingNotes", () => {
  it("is the rows nobody has written one for", () => {
    const r = summarizeReceivables([
      row({ key: "a", note: null }),
      row({ key: "b", note: "8/19 asked for update" }),
      // Whitespace is not a note.
      row({ key: "c", note: "   " }),
    ]);
    expect(rowsNeedingNotes(r).map((x) => x.key).sort()).toEqual(["a", "c"]);
  });
});

describe("withDraftedNotes", () => {
  it("fills a silent row", () => {
    const r = summarizeReceivables([row({ key: "a" })]);
    const out = withDraftedNotes(r, { a: "Sent 8/10, not yet due" });
    expect(out.rows[0].aiNote).toBe("Sent 8/10, not yet due");
    // …and leaves the human column alone, so nothing can mistake one for the other.
    expect(out.rows[0].note).toBeNull();
  });

  // The contract.
  it("NEVER touches a row a person has written on", () => {
    const r = summarizeReceivables([row({ key: "a", note: "spoke to Dave, paying Friday" })]);
    const out = withDraftedNotes(r, { a: "a draft that must not appear" });
    expect(out.rows[0].note).toBe("spoke to Dave, paying Friday");
    expect(out.rows[0].aiNote).toBeUndefined();
  });

  it("leaves a row alone when nothing was drafted for it", () => {
    const r = summarizeReceivables([row({ key: "a" }), row({ key: "b" })]);
    const out = withDraftedNotes(r, { a: "only this one" });
    expect(out.rows.find((x) => x.key === "a")?.aiNote).toBe("only this one");
    expect(out.rows.find((x) => x.key === "b")?.aiNote).toBeNull();
  });
});

describe("the CSV keeps the two apart", () => {
  // Italics and colour don't survive a spreadsheet, so the mark has to be in
  // the text itself.
  it("marks a drafted note and leaves a human one bare", () => {
    const r = withDraftedNotes(
      summarizeReceivables([
        row({ key: "invoice:1", note: "spoke to Dave" }),
        row({ key: "invoice:2", note: null }),
      ]),
      { "invoice:2": "Sent 8/10, not yet due" }
    );
    const csv = receivablesCsv(r);
    expect(csv).toContain("spoke to Dave");
    expect(csv).toContain(`${AI_NOTE_MARK} Sent 8/10, not yet due`);
    expect(csv).not.toContain(`${AI_NOTE_MARK} spoke to Dave`);
  });

  it("explains the mark, but only when one is used", () => {
    const withDraft = receivablesCsv(
      withDraftedNotes(summarizeReceivables([row({ key: "invoice:1" })]), { "invoice:1": "drafted" })
    );
    expect(withDraft).toContain("Drafted automatically");

    // A disclaimer on a sheet that has nothing to disclaim is noise.
    const humanOnly = receivablesCsv(summarizeReceivables([row({ key: "invoice:1", note: "mine" })]));
    expect(humanOnly).not.toContain("Drafted automatically");
  });
});
