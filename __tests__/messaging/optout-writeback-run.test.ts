import { describe, it, expect } from "vitest";
import {
  buildFindRecords, lastTen, soqlString, writebackEnabled, MAX_TRIES,
} from "@/lib/messaging/optout-writeback-run";
import type { E164 } from "@/lib/messaging/phone";

const PHONE = "+15163448418" as E164;

/**
 * Salesforce stores phones in every format a human ever typed. Kate's own Apex
 * matches on the last ten digits for exactly that reason, and 92 of her 213
 * unmatched opt-outs arrived over email — so matching has to do both.
 */
describe("matching a person to their Salesforce records", () => {
  const capture = () => {
    const queries: string[] = [];
    const find = buildFindRecords(async (soql) => {
      queries.push(soql);
      return { records: [] };
    });
    return { queries, find };
  };

  it("looks in Lead AND Contact", async () => {
    const { queries, find } = capture();
    await find({ phone: PHONE, email: null });
    expect(queries.some((q) => /FROM Lead/.test(q))).toBe(true);
    expect(queries.some((q) => /FROM Contact/.test(q))).toBe(true);
  });

  it("matches a phone on its last ten digits, both phone fields", async () => {
    const { queries, find } = capture();
    await find({ phone: PHONE, email: null });
    expect(queries[0]).toContain("Phone LIKE '%5163448418'");
    expect(queries[0]).toContain("MobilePhone LIKE '%5163448418'");
  });

  it("matches an email as well, because most misses were email", async () => {
    const { queries, find } = capture();
    await find({ phone: null, email: "Someone@Example.COM" });
    expect(queries[0]).toContain("Email = 'someone@example.com'");
  });

  it("skips converted leads, whose Contact is matched separately", async () => {
    const { queries, find } = capture();
    await find({ phone: PHONE, email: null });
    const lead = queries.find((q) => /FROM Lead/.test(q))!;
    expect(lead).toContain("IsConverted = false");
    expect(queries.find((q) => /FROM Contact/.test(q))).not.toContain("IsConverted");
  });

  it("asks nothing at all when there is nothing to match on", async () => {
    const { queries, find } = capture();
    expect(await find({ phone: null, email: null })).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it("marks which identifier matched, for the audit trail", async () => {
    const find = buildFindRecords(async (soql) => ({
      records: /FROM Lead/.test(soql)
        ? [{ Id: "00Q1", Email: "bob@example.com", Phone: null }]
        : [{ Id: "0031", Email: null, Phone: "(516) 344-8418" }],
    }));
    const out = await find({ phone: PHONE, email: "bob@example.com" });
    expect(out).toEqual([
      { sObject: "Lead", id: "00Q1", matchedOn: "email" },
      { sObject: "Contact", id: "0031", matchedOn: "phone" },
    ]);
  });

  it("returns every matching record, because a person can be several", async () => {
    const find = buildFindRecords(async () => ({
      records: [{ Id: "a", Phone: "5163448418" }, { Id: "b", Phone: "5163448418" }],
    }));
    expect(await find({ phone: PHONE, email: null })).toHaveLength(4); // 2 Lead + 2 Contact
  });
});

describe("nothing typed by a person reaches SOQL unescaped", () => {
  it("escapes a quote in an email address", () => {
    expect(soqlString("o'brien@example.com")).toBe("o\\'brien@example.com");
  });

  it("escapes a backslash", () => {
    expect(soqlString("a\\b")).toBe("a\\\\b");
  });

  it("carries the escape through into the query", async () => {
    const queries: string[] = [];
    const find = buildFindRecords(async (soql) => { queries.push(soql); return { records: [] }; });
    await find({ phone: null, email: "o'brien@example.com" });
    expect(queries[0]).toContain("o\\'brien@example.com");
    // The dangerous shape: an unescaped quote closing the literal early.
    expect(queries[0]).not.toContain("'o'brien");
  });
});

describe("last ten digits", () => {
  it("reads every format Salesforce actually holds", () => {
    for (const v of ["+15163448418", "(516) 344-8418", "516-344-8418", "1 516 344 8418", "5163448418"]) {
      expect(lastTen(v), v).toBe("5163448418");
    }
  });

  it("refuses something too short to be a number", () => {
    expect(lastTen("344-8418")).toBeNull();
    expect(lastTen("")).toBeNull();
    expect(lastTen(null)).toBeNull();
  });
});

/**
 * THIS WRITES TO PPP'S SYSTEM OF RECORD. Everything else in lib/messaging only
 * reads Salesforce, so the switch is the safety.
 */
describe("the switch", () => {
  it("is off unless set to exactly true", () => {
    for (const v of [undefined, "", "1", "yes", "TRUE", " true"]) {
      expect(writebackEnabled({ SF_OPTOUT_WRITEBACK: v } as unknown as NodeJS.ProcessEnv), String(v)).toBe(false);
    }
  });

  it("is on when set deliberately", () => {
    expect(writebackEnabled({ SF_OPTOUT_WRITEBACK: "true" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });

  it("gives up after a bounded number of real failures", () => {
    // A row failing on permissions must not be retried on every tick forever.
    expect(MAX_TRIES).toBeGreaterThan(0);
    expect(MAX_TRIES).toBeLessThan(10);
  });
});
