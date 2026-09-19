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

let schedulingNotes = "";
vi.mock("@/lib/salesforce/client", () => ({
  getSalesforceClient: vi.fn(async () => ({
    query: async () => ({ records: [{ Scheduling_Notes__c: schedulingNotes }] }),
  })),
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
  schedulingNotes = "";
  tokenStatus = { kind: "valid", token: token() };
});

/** Every WorkOrder field written by the last submit (it writes more than one
 *  attempt against the same record — ColorsReceived__c, Product_Lines__c and
 *  Scheduling_Notes__c each arrive separately). */
const woFields = () => {
  const last = captured.attempts[captured.attempts.length - 1] ?? [];
  return last
    .filter((a) => a.sObject === "WorkOrder")
    .reduce<Record<string, unknown>>((acc, a) => ({ ...acc, ...a.fields }), {});
};

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

  it("does not ALSO call that surface 'no finish chosen'", async () => {
    // Both notes described the same surface in contradictory words: the finish
    // was recognised-but-unusable, not absent. The second was an artefact of
    // reading the already-sanitized list.
    await post({
      lineItems: line([{ surface: "Walls", colorId: "a02C1", finish: "Rainbow Sparkle" }]),
    });
    const note = String(woliFields().ColorNotes__c ?? "");
    expect(note).toMatch(/not recogni[sz]ed/i);
    expect(note).not.toMatch(/No finish chosen/i);
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
    // Merged across every WorkOrder write: `.find` could have matched the
    // ColorsReceived__c attempt and passed this without looking at the field.
    expect(woFields().Product_Lines__c ?? null).toBe(null);
  });

  it("and saves a paint line it DOES sell", async () => {
    // The proof the assertion above is about the typo, not about paint lines
    // never being written.
    await post({
      lineItems: line([{ surface: "Walls", colorId: "a02C1", finish: "Eggshell" }]),
      materialType: "Regal Select",
    });
    expect(String(woFields().Product_Lines__c ?? "")).toMatch(/Regal Select/);
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

describe("the note the customer leaves for the crew", () => {
  const withNote = (globalNotes: string) =>
    post({ lineItems: line([{ surface: "Walls", colorId: "a02C1", finish: "Eggshell" }]), globalNotes });

  it("goes to the top of the work order's scheduling notes", async () => {
    schedulingNotes = "Gate code 4321";
    await withNote("Please knock, the bell is broken");
    expect(String(woFields().Scheduling_Notes__c ?? "")).toBe(
      "Customer (color form): Please knock, the bell is broken\n\nGate code 4321"
    );
  });

  it("REPLACES what the same customer said last time, instead of stacking it", async () => {
    // Two contradictory instructions, with nothing to say which came later,
    // is worse than either one alone.
    schedulingNotes = "Customer (color form): Please knock, the bell is broken\n\nGate code 4321";
    tokenStatus = {
      kind: "editable",
      token: token({ submitted_payload: { globalNotes: "Please knock, the bell is broken" } }),
    };
    await withNote("Actually the bell works now, please ring it");
    const out = String(woFields().Scheduling_Notes__c ?? "");
    expect(out).toBe("Customer (color form): Actually the bell works now, please ring it\n\nGate code 4321");
    expect(out).not.toMatch(/knock/);
  });

  it("writes nothing at all when the note has not changed", async () => {
    schedulingNotes = "Customer (color form): Please knock, the bell is broken\n\nGate code 4321";
    tokenStatus = {
      kind: "editable",
      token: token({ submitted_payload: { globalNotes: "Please knock, the bell is broken" } }),
    };
    await withNote("Please knock, the bell is broken");
    expect(woFields()).not.toHaveProperty("Scheduling_Notes__c");
  });

  it("keeps a multi-paragraph note whole", async () => {
    // Any "cut at the blank line" rule would have split this one in half.
    const old = "First thing.\n\nSecond thing.";
    schedulingNotes = `Customer (color form): ${old}\n\nGate code 4321`;
    tokenStatus = { kind: "editable", token: token({ submitted_payload: { globalNotes: old } }) };
    await withNote("Just one thing now.");
    const out = String(woFields().Scheduling_Notes__c ?? "");
    expect(out).toBe("Customer (color form): Just one thing now.\n\nGate code 4321");
  });
});

describe("un-skipping a surface (Katie 2026-09-19: \"can they undo it?\")", () => {
  const skip = (surface: string) => ({ surface, colorId: null, finish: null, skipped: true });

  it("records the skip, and says so where the crew reads it", async () => {
    await post({ lineItems: line([skip("Walls")]) });
    expect(String(woliFields().ColorNotes__c ?? "")).toMatch(/Don't paint this surface.*Walls/i);
  });

  it("changing their mind TO 'don't paint' clears the color they had chosen", async () => {
    // The other direction, and the one that was uncovered: on a re-edit the
    // skip has to null the Salesforce color, or the crew paints a surface the
    // customer has just told us to leave. (Mutation testing, 2026-09-19.)
    tokenStatus = { kind: "editable", token: token() };
    await post({ lineItems: line([skip("Walls")]) });
    const f = woliFields();
    expect(f).toHaveProperty("ColorWall__c", null);
    expect(f).toHaveProperty("FinishWall__c", null);
    expect(String(f.ColorNotes__c ?? "")).toMatch(/Don't paint this surface.*Walls/i);
  });

  it("and a re-edit that picks a color CLEARS the skip everywhere", async () => {
    // The customer changed their mind and chose a color. Salesforce has to
    // carry the color, and the note has to stop saying "don't paint" — a
    // stale line there tells the crew to leave a wall the customer now wants
    // painted.
    tokenStatus = { kind: "editable", token: token() };
    await post({
      lineItems: line([{ surface: "Walls", colorId: "a02C1", finish: "Eggshell" }]),
    });
    const f = woliFields();
    expect(f.ColorWall__c).toBe("a02C1");
    expect(f.FinishWall__c).toBe("Eggshell");
    expect(String(f.ColorNotes__c ?? "")).not.toMatch(/Don't paint this surface/i);
  });

  it("…and an un-skip with no color chosen leaves the surface genuinely blank", async () => {
    // Un-skipping clears the color, so this is the state between the undo and
    // the new pick. It must read as "nobody has answered" rather than keeping
    // either the skip or a color nobody chose.
    tokenStatus = { kind: "editable", token: token() };
    await post({ lineItems: line([{ surface: "Walls", colorId: null, finish: null }]) });
    const f = woliFields();
    expect(f).toHaveProperty("ColorWall__c", null);
    expect(String(f.ColorNotes__c ?? "")).not.toMatch(/Don't paint this surface/i);
  });

  it("a prior submission's skip note is not re-stacked on top of the new one", async () => {
    // The note is regenerated from the CURRENT state every submit; the old
    // copy is stripped first. Two contradictory lines would be worse than
    // either one alone.
    tokenStatus = { kind: "editable", token: token() };
    await post({ lineItems: line([skip("Walls"), skip("Ceiling")]) });
    const note = String(woliFields().ColorNotes__c ?? "");
    expect(note.match(/Don't paint this surface/gi) ?? []).toHaveLength(2);
  });
});

