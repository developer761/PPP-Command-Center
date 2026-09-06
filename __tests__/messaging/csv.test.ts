import { describe, it, expect } from "vitest";
import { parseCsv, parseCsvRows, matchHeader } from "@/lib/messaging/csv";

describe("parseCsvRows — the cases split(',') gets silently wrong", () => {
  it("keeps a comma inside a quoted field", () => {
    // A real customer message: "Kitchen, two bathrooms, and the hallway"
    expect(parseCsvRows('a,"one, two",c')).toEqual([["a", "one, two", "c"]]);
  });

  it("keeps a LINE BREAK inside a quoted field", () => {
    // Multi-line messages are normal in a transcript export. Splitting on \n
    // would turn one conversation into two broken rows.
    expect(parseCsvRows('a,"line1\nline2",c')).toEqual([["a", "line1\nline2", "c"]]);
  });

  it("unescapes a doubled quote", () => {
    expect(parseCsvRows('a,"he said ""hi""",c')).toEqual([["a", 'he said "hi"', "c"]]);
  });

  it("strips a UTF-8 BOM from the first field", () => {
    // Through parseCsvRows, which does NOT trim. Asserting this via parseCsv
    // proved nothing: trim() treats U+FEFF as whitespace, so that version
    // passed with the strip deleted. Found by mutating the source and watching
    // the test not care.
    expect(parseCsvRows("﻿Date,Body")).toEqual([["Date", "Body"]]);
  });

  it("parseCsv survives a BOM regardless, via trim", () => {
    const { headers } = parseCsv("﻿Date,Body\n2026-01-01,hi");
    expect(headers[0]).toBe("Date");
  });

  it("handles CRLF without leaving \\r in the last value", () => {
    expect(parseCsvRows("a,b\r\nc,d")).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("does not invent a phantom row from a trailing newline", () => {
    expect(parseCsvRows("a,b\nc,d\n")).toHaveLength(2);
  });

  it("handles an empty field and an all-empty row", () => {
    expect(parseCsvRows("a,,c")).toEqual([["a", "", "c"]]);
    expect(parseCsvRows("a,b\n\nc,d")).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("returns nothing for empty or whitespace-only input", () => {
    expect(parseCsvRows("")).toEqual([]);
    expect(parseCsvRows("\n\n")).toEqual([]);
  });
});

describe("parseCsv — ragged rows are reported, never dropped", () => {
  it("keeps a short row and says so", () => {
    // A silently discarded row is a training example nobody can trace.
    const r = parseCsv("a,b,c\n1,2");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toEqual({ a: "1", b: "2", c: "" });
    expect(r.ragged).toEqual([{ line: 2, got: 2, expected: 3 }]);
  });

  it("keeps a long row and says so", () => {
    const r = parseCsv("a,b\n1,2,3");
    expect(r.ragged[0]).toMatchObject({ got: 3, expected: 2 });
  });

  it("trims header and cell whitespace", () => {
    const r = parseCsv(" Name , Body \n Alice , hello ");
    expect(r.headers).toEqual(["Name", "Body"]);
    expect(r.rows[0]).toEqual({ Name: "Alice", Body: "hello" });
  });
});

describe("matchHeader — Kate's columns will not be named ours", () => {
  it("matches exactly, ignoring case and punctuation", () => {
    expect(matchHeader(["Opt-Out Date", "Channel"], ["channel"])).toBe("Channel");
    expect(matchHeader(["Hatch_Contact_Name"], ["hatch contact name"])).toBe("Hatch_Contact_Name");
  });

  it("prefers the longest match when several could apply", () => {
    // "Customer Name" should win over "Name" for a "customer name" candidate.
    const headers = ["Name", "Customer Name"];
    expect(matchHeader(headers, ["customer name"])).toBe("Customer Name");
  });

  it("returns null rather than guessing when nothing is close", () => {
    expect(matchHeader(["Foo", "Bar"], ["transcript"])).toBeNull();
  });

  it("ignores empty headers", () => {
    expect(matchHeader(["", "Body"], ["body"])).toBe("Body");
  });
});
