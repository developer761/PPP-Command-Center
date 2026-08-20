import { describe, it, expect } from "vitest";
import {
  staleRows,
  withDraftedNotes,
  rowFactHash,
  AI_NOTE_MARK,
  type RowNoteEntry,
} from "@/lib/commercial/reports/receivables-row-notes";
import { summarizeReceivables, type ReceivableRow } from "@/lib/commercial/reports/receivables";
import { receivablesCsv } from "@/lib/commercial/reports/receivables-export";

/**
 * The AI read is a SECOND COLUMN beside the office's, never inside it.
 *
 * Two behaviours carry the whole design and both are pinned here: the two
 * columns never merge, and staleness is per ROW — so a note typed after a draft
 * exists reconsiders that row and only that row.
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

/** A cache in which every row's read is CURRENT — built from the module's own
 *  hash, the way `generateRowNotes` stores it. */
function currentCache(report: ReturnType<typeof summarizeReceivables>): Record<string, RowNoteEntry> {
  const out: Record<string, RowNoteEntry> = {};
  for (const r of report.rows) {
    out[r.key] = { note: `read ${r.key}`, hash: rowFactHash(r, report), at: "2026-08-19T00:00:00Z" };
  }
  return out;
}

describe("staleRows", () => {
  it("treats every row as stale when nothing has been written", () => {
    const report = summarizeReceivables([row({ key: "a" }), row({ key: "b" })]);
    expect(staleRows(report, {}).map((r) => r.key).sort()).toEqual(["a", "b"]);
  });

  it("treats a read written from different facts as stale", () => {
    const report = summarizeReceivables([row({ key: "a" })]);
    const stale = { a: { note: "old", hash: "written-from-something-else", at: "" } };
    expect(staleRows(report, stale)).toHaveLength(1);
  });

  // The behaviour Karan asked for: a note typed AFTER a draft exists must
  // reconsider that row, because the office's words are part of what the read
  // is written from.
  it("a note typed after the draft makes THAT row stale", () => {
    const before = summarizeReceivables([row({ key: "a", note: null }), row({ key: "b", note: null })]);
    // Pretend both were drafted: capture their hashes by asking the module.
    const cache = currentCache(before);
    expect(staleRows(before, cache)).toHaveLength(0);

    // Somebody writes a note on row a.
    const after = summarizeReceivables([
      row({ key: "a", note: "spoke to Dave, paying Friday" }),
      row({ key: "b", note: null }),
    ]);
    const nowStale = staleRows(after, cache).map((r) => r.key);
    expect(nowStale).toEqual(["a"]);
    // …and row b keeps the exact words it had. A report whose wording churns
    // every morning for no reason is one people stop reading closely.
    expect(cache.b.note).toBe("read b");
  });

  it("a changed amount or age makes a row stale too", () => {
    const before = summarizeReceivables([row({ key: "a", openCents: 100_00 })]);
    const cache = currentCache(before);
    expect(staleRows(before, cache)).toHaveLength(0);

    const paidDown = summarizeReceivables([row({ key: "a", openCents: 40_00 })]);
    expect(staleRows(paidDown, cache)).toHaveLength(1);
  });
});



describe("withDraftedNotes", () => {
  it("attaches a read to EVERY row, including ones the office wrote on", () => {
    // The old design skipped those. Karan: the AI column should carry a note
    // forward, not go silent because one exists.
    const r = summarizeReceivables([
      row({ key: "a", note: null }),
      row({ key: "b", note: "Change order billing" }),
    ]);
    const out = withDraftedNotes(r, { a: "sent 8/10, not yet due", b: "CO billing, sent 8/10 — nothing to chase yet" });
    expect(out.rows.find((x) => x.key === "a")?.aiNote).toBe("sent 8/10, not yet due");
    expect(out.rows.find((x) => x.key === "b")?.aiNote).toBe("CO billing, sent 8/10 — nothing to chase yet");
  });

  it("never touches the office's own column", () => {
    const r = summarizeReceivables([row({ key: "a", note: "spoke to Dave, paying Friday" })]);
    const out = withDraftedNotes(r, { a: "a read that must not replace her words" });
    expect(out.rows[0].note).toBe("spoke to Dave, paying Friday");
  });

  it("leaves a row's read null when nothing was written for it", () => {
    const r = summarizeReceivables([row({ key: "a" }), row({ key: "b" })]);
    const out = withDraftedNotes(r, { a: "only this one" });
    expect(out.rows.find((x) => x.key === "b")?.aiNote).toBeNull();
  });
});

/** Split one CSV line into cells, respecting quotes — a note with a comma in
 *  it is exactly what a naive split gets wrong. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { out.push(cell); cell = ""; }
    else cell += ch;
  }
  out.push(cell);
  return out;
}

describe("the CSV keeps them in separate columns", () => {
  const report = withDraftedNotes(
    summarizeReceivables([
      row({ key: "invoice:1", note: "spoke to Dave" }),
      row({ key: "invoice:2", note: null }),
    ]),
    { "invoice:1": "chased 8/19, expect Friday", "invoice:2": "sent 8/10, not yet due" }
  );
  const csv = receivablesCsv(report);

  it("has a column for each", () => {
    // A spreadsheet has no italics and no colour — the only way to keep them
    // apart is two headers.
    expect(csv).toContain(`"Notes"`);
    expect(csv).toContain(`"${AI_NOTE_MARK} AI read"`);
  });

  it("keeps the office's words out of the AI column and vice versa", () => {
    const cols = parseCsvLine(csv.split("\r\n").find((l) => l.includes("AI read"))!);
    const noteIdx = cols.indexOf("Notes");
    const aiIdx = cols.findIndex((c) => c.includes("AI read"));
    expect(aiIdx).toBe(noteIdx + 1);

    const dave = parseCsvLine(csv.split("\r\n").find((l) => l.includes("spoke to Dave"))!);
    expect(dave[noteIdx]).toBe("spoke to Dave");
    // A read containing a comma has to survive its own column — which is the
    // whole reason every field is quoted.
    expect(dave[aiIdx]).toBe("chased 8/19, expect Friday");
  });

  it("explains the two columns, but only when a read exists", () => {
    expect(csv).toContain("The AI read column is written from");
    const noReads = receivablesCsv(summarizeReceivables([row({ key: "invoice:1", note: "mine" })]));
    expect(noReads).not.toContain("The AI read column is written from");
  });
});
