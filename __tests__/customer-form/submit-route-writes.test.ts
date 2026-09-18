import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SfWriteAttempt } from "@/lib/salesforce/writeback";

/**
 * The FIRST test that actually runs the submit route.
 *
 * Mutation testing found 8 of 8 mutations in this file survive the whole
 * suite: every other test that mentions it reads it with `readFileSync` and
 * asserts on its source text. Deleting the paint-line guard, deleting the
 * missing-finish note, dropping `paintOrdered` — all invisible. It is the only
 * place a customer's colors become Salesforce writes.
 *
 * So this drives the real POST handler and asserts on the ARTIFACT: the write
 * attempts it hands to Salesforce, and the payload it stores.
 */

const captured: { attempts: SfWriteAttempt[][]; payloads: unknown[] } = { attempts: [], payloads: [] };

let tokenStatus: Record<string, unknown> = {};

vi.mock("@/lib/customer-form/tokens", () => ({
  validateToken: vi.fn(async () => tokenStatus),
  markSubmitted: vi.fn(async (_t: string, payload: unknown) => {
    captured.payloads.push(payload);
    // `fresh` = this request won the double-submit race, so it is the one that
    // writes. Without it the route accepts the submit and writes nothing.
    return { ok: true, fresh: true };
  }),
  markResubmitted: vi.fn(async (_t: string, payload: unknown) => {
    captured.payloads.push(payload);
    return { ok: true };
  }),
}));

const RENDER_DATA = {
  workOrder: { id: "0WO1", workOrderNumber: "00300099", accountName: "Test" },
  lineItems: [
    {
      id: "wl-1",
      areaLabel: "Living Room",
      surfaces: [{ surface: "Walls" }, { surface: "Ceiling" }],
      colorNotes: null,
    },
  ],
};

vi.mock("@/lib/customer-form/render-data", () => ({
  loadFormRenderData: vi.fn(async () => RENDER_DATA),
  invalidateFormRenderData: vi.fn(),
}));

vi.mock("@/lib/salesforce/writeback", () => ({
  writeSfBatch: vi.fn(async (attempts: SfWriteAttempt[]) => {
    captured.attempts.push(attempts);
    return attempts.map((a) => ({ ok: true as const, recordId: a.recordId, attempts: 1 }));
  }),
}));

vi.mock("@/lib/salesforce/client", () => ({
  getSalesforceClient: vi.fn(async () => ({})),
}));

vi.mock("@/lib/salesforce/picklists", () => ({
  // Salesforce accepts these three and nothing else.
  activePicklistValues: vi.fn(async () => ["Eggshell", "Flat", "Semi-Gloss"]),
  resolveFinishValue: (raw: string | null) => raw,
}));

vi.mock("@/lib/customer-form/writeback-mode", () => ({
  decideWriteback: vi.fn(async () => ({ mode: "on", shouldWrite: true, isInAllowlist: true, reason: null })),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(() => ({ ok: true })),
  sweepRateLimit: vi.fn(),
}));

vi.mock("@/lib/customer-form/notify-sender", () => ({ notifySenderOnSubmit: vi.fn(async () => {}) }));
vi.mock("@/lib/notifications/insert", () => ({ insertCustomerFormSubmittedNotification: vi.fn(async () => {}) }));
vi.mock("@/lib/customer-form/sf-failure-alert", () => ({ alertSalesforceWriteFailure: vi.fn(async () => {}) }));

const { POST } = await import("@/app/api/customer-form/submit/[token]/route");

type Surface = { surface: string; colorId: string | null; finish: string | null; skipped?: boolean };

function post(body: Record<string, unknown>) {
  return POST(
    new Request("http://x/api/customer-form/submit/tok", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "tok", ...body }),
    }),
    { params: Promise.resolve({ token: "tok" }) }
  );
}

const token = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  work_order_id: "0WO1",
  work_order_number: "00300099",
  kind: "customer",
  customer_name: "Test",
  ...over,
});

const line = (surfaces: Surface[]) => [{ id: "wl-1", surfaces, notes: "" }];

/** The WorkOrderLineItem write for wl-1 from the last submit. */
const woliFields = () => {
  const last = captured.attempts[captured.attempts.length - 1] ?? [];
  return last.find((a) => a.sObject === "WorkOrderLineItem" && a.recordId === "wl-1")?.fields ?? {};
};

beforeEach(() => {
  captured.attempts = [];
  captured.payloads = [];
  tokenStatus = { kind: "valid", token: token() };
});

describe("a color the customer picked", () => {
  it("reaches Salesforce with its finish", async () => {
    const res = await post({ lineItems: line([{ surface: "Walls", colorId: "a02C1", finish: "Eggshell" }]) });
    expect(res.status).toBe(200);
    expect(woliFields().ColorWall__c).toBe("a02C1");
    expect(woliFields().FinishWall__c).toBe("Eggshell");
  });
});

describe("a color the customer REMOVED on a re-edit", () => {
  it("is cleared in Salesforce, not left standing", async () => {
    // "Change" pressed, nothing re-picked. The form shows the surface empty;
    // Salesforce used to keep the old color and the crew painted it.
    tokenStatus = { kind: "editable", token: token() };
    await post({ lineItems: line([{ surface: "Walls", colorId: null, finish: null }]) });
    expect(woliFields()).toHaveProperty("ColorWall__c", null);
    expect(woliFields()).toHaveProperty("FinishWall__c", null);
  });

  it("but a blank surface on a FIRST submit never clears anything", async () => {
    // Here blank means "no answer", and the office may have entered a color
    // already. Writing null over it would destroy it.
    await post({ lineItems: line([{ surface: "Walls", colorId: null, finish: null }]) });
    expect(woliFields()).not.toHaveProperty("ColorWall__c");
    expect(woliFields()).not.toHaveProperty("FinishWall__c");
  });
});

describe("an answer Salesforce cannot store", () => {
  it("does not take the rest of the room down with it (WO 00317803)", async () => {
    // Three good rooms and one unrecognised finish used to save NOTHING.
    const res = await post({
      lineItems: line([
        { surface: "Walls", colorId: "a02C1", finish: "Eggshell" },
        { surface: "Ceiling", colorId: "a02C2", finish: "Rainbow Sparkle" },
      ]),
    });
    expect(res.status).toBe(200);
    const f = woliFields();
    expect(f.ColorWall__c).toBe("a02C1");
    // The ceiling's COLOR still saves; only the unusable finish is dropped…
    expect(f.ColorCeiling__c).toBe("a02C2");
    expect(f.FinishCeiling__c ?? null).toBe(null);
    // …and what the customer chose is recorded where PPP will see it.
    expect(String(f.ColorNotes__c ?? "")).toMatch(/not recogni[sz]ed/i);
    expect(String(f.ColorNotes__c ?? "")).toMatch(/Rainbow Sparkle/);
  });

  it("records a color picked with no finish at all", async () => {
    // Two sheens of one color are two SKUs, so a missing finish has to be
    // visible rather than silently ordered.
    await post({ lineItems: line([{ surface: "Walls", colorId: "a02C1", finish: null }]) });
    expect(String(woliFields().ColorNotes__c ?? "")).toMatch(/No finish chosen/i);
  });

  it("accepts a paint line it does not sell, and says so", async () => {
    const res = await post({
      lineItems: line([{ surface: "Walls", colorId: "a02C1", finish: "Eggshell" }]),
      materialType: "Regal Selectt",
    });
    // Not a 400: the colors are the point, the typo is a note.
    expect(res.status).toBe(200);
    expect(String(woliFields().ColorNotes__c ?? "")).toMatch(/Paint line not recogni[sz]ed/i);
    const last = captured.attempts[captured.attempts.length - 1] ?? [];
    expect(last.find((a) => a.sObject === "WorkOrder")?.fields.Product_Lines__c ?? null).toBe(null);
  });

  it("and saves a paint line it DOES sell", async () => {
    // The proof the assertion above is about the typo, not about paint lines
    // never being written.
    await post({
      lineItems: line([{ surface: "Walls", colorId: "a02C1", finish: "Eggshell" }]),
      materialType: "Regal Select",
    });
    const last = captured.attempts[captured.attempts.length - 1] ?? [];
    expect(String(last.find((a) => a.sObject === "WorkOrder")?.fields.Product_Lines__c ?? "")).toMatch(/Regal Select/);
  });
});

describe("what gets stored for next time", () => {
  it("keeps both paint lines, so a re-edit starts where the last one ended", async () => {
    await post({
      lineItems: line([{ surface: "Walls", colorId: "a02C1", finish: "Eggshell" }]),
      materialType: "Regal Select",
      materialTypeExterior: "Ultra Spec Exterior Satin",
    });
    const stored = captured.payloads[captured.payloads.length - 1] as Record<string, unknown>;
    expect(stored.materialType).toBe("Regal Select");
    expect(stored.materialTypeExterior).toBe("Ultra Spec Exterior Satin");
  });
});
