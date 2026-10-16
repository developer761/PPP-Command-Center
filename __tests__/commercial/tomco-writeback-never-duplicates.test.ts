/**
 * F23 — the four ways a lost link could put a SECOND sale or change order into
 * Tomco's Salesforce, each driven here and shown closed.
 *
 *   (a) createNew wrote the import-map link LAST, after an unchecked
 *       `Quote.update` that could throw past it → a Closed Won opportunity with
 *       no link, which every later tick and the importer would insert again.
 *   (b) the tick's link read dropped `error`, so a failed read meant "never
 *       linked" → the INSERT path for a deal Salesforce already had.
 *   (c) the change-order anti-steal guard dropped `error` and read the whole
 *       link table unpaged → every record looked unclaimed.
 *   (d) a person's "it is a second change order" marker was never spent → a
 *       later lost link created the change order again.
 *
 * (a) and the sale-adopt path drive the real `createNew` against a fake
 * connection that records every create — the creates ARE the assertion. (c)
 * and (d) are the pure `planUnlinkedChangeOrder`. (b) is in
 * tomco-tick-holds-and-deletes.test.ts, through the real tick.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** Every Salesforce create, in order. */
  creates: [] as Array<{ sObject: string; fields: Record<string, unknown> }>,
  /** Every `writeSf` update, in order. */
  updates: [] as Array<{ sObject: string; fields: Record<string, unknown> }>,
  /** Every import-map upsert, with the create count at the moment it happened. */
  links: [] as Array<{ row: Record<string, unknown>; createsSoFar: number }>,
  /** What the external-id lookup returns. */
  byExternalId: null as null | { Id: string; Name: string; StageName: string },
  /** Make `writeSf` refuse this object. */
  refuse: null as null | string,
}));

vi.mock("@/lib/salesforce/writeback", () => ({
  writeSf: async (a: { sObject: string; fields: Record<string, unknown> }) => {
    h.updates.push({ sObject: a.sObject, fields: a.fields });
    return h.refuse === a.sObject ? { ok: false, error: "UNABLE_TO_LOCK_ROW", errorCode: "X", recordId: "x", attempts: 1 } : { ok: true, recordId: "x", attempts: 1 };
  },
  logSfCreate: async () => {},
}));

vi.mock("@supabase/supabase-js", () => {
  const builder: Record<string, unknown> = {};
  builder.upsert = (row: Record<string, unknown>) => {
    h.links.push({ row, createsSoFar: h.creates.length });
    return { select: async () => ({ data: [{ sf_id: row.sf_id }], error: null }) };
  };
  return { createClient: () => ({ from: () => builder }) };
});

const { createNew, missingFromOwnBuild } = await import("@/lib/salesforce/tomco-writeback");
const { planUnlinkedChangeOrder } = await import("@/lib/salesforce/tomco-changeorder");

let seq = 0;
const fakeConn = () =>
  ({
    query: async (q: string) => {
      if (/FROM Opportunity WHERE UniqueExternalId__c/.test(q)) {
        if (/COUNT\(Id\)/.test(q)) return { records: [{ n: 1 }] };
        return { records: h.byExternalId ? [h.byExternalId] : [] };
      }
      if (/FROM RecordType/.test(q)) return { records: [{ Id: "012000000000001AAA" }] };
      if (/FROM Pricebook2 /.test(q)) return { records: [{ Id: "01s000000000001AAA" }] };
      if (/FROM PricebookEntry/.test(q)) return { records: [{ Id: "01u000000000001AAA", Product2Id: "01t000000000001AAA", UnitPrice: 500 }] };
      if (/FROM User/.test(q)) return { records: [{ Id: "005000000000001AAA" }] };
      if (/SELECT Name FROM Opportunity/.test(q)) return { records: [{ Name: "Job A" }] };
      if (/SELECT Id, StageName, Corporate_Name__c/.test(q))
        return { records: [{ Id: "006000000000001AAA", StageName: h.byExternalId?.StageName ?? "Closed Won", Corporate_Name__c: "Tomco Painting", Quote_Subtotal__c: 100, QuotedSubtotalWithChangeOrder__c: 100 }] };
      return { records: [] };
    },
    sobject: (sObject: string) => ({
      create: async (fields: Record<string, unknown>) => {
        h.creates.push({ sObject, fields });
        return { success: true, id: `${sObject === "Opportunity" ? "006" : sObject === "Quote" ? "0Q0" : "0QL"}00000000000${String(++seq).padStart(3, "0")}` };
      },
    }),
  }) as never;

const deal = { id: "33333333-3333-4333-8333-333333333333", title: "Job A", accountName: "GC", contractCents: 10_000, decidedAt: "2026-10-16" };
const ctx = () => ({ conn: fakeConn(), actorUserId: null, apply: true });

beforeEach(() => {
  h.creates.length = 0;
  h.updates.length = 0;
  h.links.length = 0;
  h.byExternalId = null;
  h.refuse = null;
});

describe("(a) the link is written the moment the opportunity exists", () => {
  it("before the quote is created — and a failed approval leaves it linked, with nothing else created", async () => {
    h.refuse = "Quote"; // the approval — `Quote.update` — is refused
    const r = await createNew(ctx(), deal, { accountId: "001000000000001AAA", closeDate: "2026-10-16" });
    expect(r.action).toBe("failed");
    // exactly one opportunity, and the link written right after it, before the quote
    expect(h.creates.filter((c) => c.sObject === "Opportunity")).toHaveLength(1);
    expect(h.links).toHaveLength(1);
    expect(h.links[0].createsSoFar).toBe(1);
    expect(h.links[0].row).toMatchObject({ entity: "deal", row_id: deal.id, notes: "created by the Tomco write-back" });
  });

  it("the approval is checked now — it used to be an unchecked update that threw past the link", async () => {
    h.refuse = "Quote";
    const r = await createNew(ctx(), deal, { accountId: null, closeDate: "2026-10-16" });
    expect(r.error).toMatch(/quote approval/);
    expect(h.updates.some((u) => u.sObject === "Quote" && u.fields.Status === "Approved")).toBe(true);
  });
});

describe("a sale Salesforce already has under this deal's external id is ADOPTED, not created again", () => {
  it("links it and creates nothing", async () => {
    h.byExternalId = { Id: "006000000000001AAA", Name: "Job A", StageName: "Closed Won" };
    const r = await createNew(ctx(), deal, { accountId: null, closeDate: "2026-10-16" });
    expect(h.creates).toEqual([]);
    expect(h.links).toHaveLength(1);
    expect(h.links[0].row).toMatchObject({ sf_id: "006000000000001AAA", row_id: deal.id });
    expect(r.action).toBe("adopted");
  });

  it("🔴 the old behaviour, for contrast: with no lookup hit it DOES create — so the assertion above is not vacuous", async () => {
    await createNew(ctx(), deal, { accountId: null, closeDate: "2026-10-16" });
    expect(h.creates.map((c) => c.sObject)).toEqual(["Opportunity", "Quote", "QuoteLineItem"]);
  });
});

describe("a half-built sale of ours is named, not called done", () => {
  const whole = { stageName: "Closed Won", syncedQuoteId: "0Q0A", quotes: [{ id: "0Q0A", status: "Approved", lines: 1 }] };
  it("a complete build has nothing missing", () => expect(missingFromOwnBuild(whole)).toEqual([]));
  it.each([
    ["no quote", { ...whole, quotes: [] }],
    ["no line", { ...whole, quotes: [{ id: "0Q0A", status: "Approved", lines: 0 }] }],
    ["Draft quote", { ...whole, quotes: [{ id: "0Q0A", status: "Draft", lines: 1 }] }],
    ["not synced", { ...whole, syncedQuoteId: null }],
    ["two quotes", { ...whole, quotes: [whole.quotes[0], { id: "0Q0B", status: "Draft", lines: 1 }] }],
  ])("%s is missing something", (_n, input) => expect(missingFromOwnBuild(input).length).toBeGreaterThan(0));
});

describe("(c)(d) a change order with no link row", () => {
  const local = { id: "co-1", amountCents: 2_037_500, shouldCount: true, title: "Wallcovering", description: "Touch-ups" };
  const base = {
    local,
    sfCos: [] as Array<{ Id: string; Name: string; CostChange__c: number | null; Status__c: string | null; Notes__c?: string | null }>,
    claimedBy: new Map<string, string>(),
    createdForThis: new Set<string>(),
    personSaysItIsNew: false,
    liveRollupCents: 0,
  };
  const ours = { Id: "a09000000000001AAA", Name: "CO-32669", CostChange__c: 20_375, Status__c: "Approved", Notes__c: "Wallcovering — Touch-ups" };

  it("nothing in Salesforce → create", () => expect(planUnlinkedChangeOrder(base).kind).toBe("create"));

  it("🔴 (d) a record the write-back made for THIS change order is recovered — even with a person's force-new marker still standing", () => {
    const edited = { ...ours, CostChange__c: 19_000 }; // amount changed here since: no amount match to save it
    const p = planUnlinkedChangeOrder({ ...base, sfCos: [edited], createdForThis: new Set([edited.Id]), personSaysItIsNew: true });
    expect(p.kind).toBe("recover");
  });

  it("…found by its own Notes__c when the queue history has no id", () => {
    const p = planUnlinkedChangeOrder({ ...base, sfCos: [{ ...ours, CostChange__c: 19_000 }] });
    expect(p.kind).toBe("recover");
  });

  it("🔴 (c) a record linked to ANOTHER change order here is never adopted", () => {
    const p = planUnlinkedChangeOrder({ ...base, sfCos: [{ ...ours, Notes__c: null }], claimedBy: new Map([[ours.Id, "co-2"]]) });
    expect(p.kind).toBe("hold");
  });

  it("one unclaimed record at this amount is adopted", () => {
    expect(planUnlinkedChangeOrder({ ...base, sfCos: [{ ...ours, Notes__c: null }] }).kind).toBe("adopt");
  });

  it("🔴 VCA West Islip: Salesforce money nobody here stands for HOLDS the create", () => {
    // CO-32409, $14,625, Approved — the rollup row standing for it was deleted here.
    const sfOnly = { Id: "a09000000000002AAA", Name: "CO-32409", CostChange__c: 14_625, Status__c: "Approved", Notes__c: null };
    const p = planUnlinkedChangeOrder({ ...base, sfCos: [sfOnly] });
    expect(p.kind).toBe("hold");
    expect(p.why).toMatch(/additional to them/);
    // with the rollup row still live it stands for that money, and the create goes ahead
    expect(planUnlinkedChangeOrder({ ...base, sfCos: [sfOnly], liveRollupCents: 1_462_500 }).kind).toBe("create");
    // and a person who says "it is additional" is believed
    expect(planUnlinkedChangeOrder({ ...base, sfCos: [sfOnly], personSaysItIsNew: true }).kind).toBe("create");
  });

  it("a record Tomco's org denied is never turned back on", () => {
    expect(planUnlinkedChangeOrder({ ...base, sfCos: [{ ...ours, Notes__c: null, Status__c: "Denied" }] }).kind).toBe("hold");
  });

  it("reversed here and never in Salesforce → nothing", () => {
    expect(planUnlinkedChangeOrder({ ...base, local: { ...local, shouldCount: false } }).kind).toBe("nothing");
  });
});
