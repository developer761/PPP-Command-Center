import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildAttribution } from "@/lib/wo-progress/attribution";

/**
 * Kate round-3 #02 + #03 — who did what.
 *
 * This came back from round 2 because the logic existed but lived in a loader
 * the materials page doesn't use. Now both loaders call buildAttribution, so
 * these tests pin the BEHAVIOUR rather than any one call site:
 *
 *   internal token  → every event belongs to the named staffer
 *   customer token  → the open and the submit are the customer's, even though
 *                     a staffer sent the link
 */

/** Minimal stand-in for the profiles lookup buildAttribution performs. */
function fakeSupabase(profiles: Array<{ user_id: string; sf_user_name: string | null; email: string | null }>) {
  return {
    from: () => ({
      select: () => ({
        in: async () => ({ data: profiles, error: null }),
      }),
    }),
  } as unknown as SupabaseClient;
}

const sb = fakeSupabase([
  { user_id: "u-amy", sf_user_name: "Amy Mariano", email: "amy@precisionpaintingplus.net" },
  { user_id: "u-noname", sf_user_name: null, email: "trish@precisionpaintingplus.net" },
]);

describe("buildAttribution", () => {
  it("attributes an internal entry to the staffer, by first name (#02)", async () => {
    const out = await buildAttribution(sb, [
      {
        work_order_id: "wo1",
        kind: "internal",
        created_by_user_id: "u-amy",
        opened_at: "2026-08-14T10:00:00Z",
        submitted_at: "2026-08-14T10:05:00Z",
      },
    ]);
    // Katie's example: the bar should read "Amy Submitted", not "Amy Mariano Submitted".
    expect(out.get("wo1")).toEqual({
      entryMode: "internal",
      sentByName: "Amy",
      openedByName: "Amy",
      submittedByName: "Amy",
    });
  });

  it("leaves a customer submission attributed to the customer", async () => {
    const out = await buildAttribution(sb, [
      {
        work_order_id: "wo2",
        kind: null,
        created_by_user_id: "u-amy",
        opened_at: "2026-08-14T10:00:00Z",
        submitted_at: "2026-08-14T10:05:00Z",
      },
    ]);
    const a = out.get("wo2")!;
    expect(a.entryMode).toBe("customer");
    // A staffer SENT it, so that's attributable...
    expect(a.sentByName).toBe("Amy");
    // ...but the customer opened and submitted it. Returning null here is what
    // makes the UI say "by the customer" instead of inventing a name.
    expect(a.openedByName).toBeNull();
    expect(a.submittedByName).toBeNull();
  });

  it("does not claim an internal form was opened or submitted before it was", async () => {
    // The round-2 bug in miniature: labels were keyed off submittedByName, so a
    // form an AM had opened but not yet submitted reported the wrong thing.
    const out = await buildAttribution(sb, [
      { work_order_id: "wo3", kind: "internal", created_by_user_id: "u-amy", opened_at: "2026-08-14T10:00:00Z", submitted_at: null },
    ]);
    const a = out.get("wo3")!;
    expect(a.openedByName).toBe("Amy");
    expect(a.submittedByName).toBeNull();
  });

  it("falls back to the email local-part when there's no Salesforce name", async () => {
    const out = await buildAttribution(sb, [
      { work_order_id: "wo4", kind: "internal", created_by_user_id: "u-noname", opened_at: null, submitted_at: "2026-08-14T10:00:00Z" },
    ]);
    expect(out.get("wo4")!.submittedByName).toBe("trish");
  });

  it("still labels an internal entry when the staffer can't be resolved", async () => {
    const out = await buildAttribution(sb, [
      { work_order_id: "wo5", kind: "internal", created_by_user_id: "u-unknown", opened_at: null, submitted_at: "2026-08-14T10:00:00Z" },
    ]);
    // Better than falling through to "Customer Submitted", which is the exact
    // wrong answer Kate reported.
    expect(out.get("wo5")!.submittedByName).toBe("Internal entry");
  });

  it("survives a profiles lookup failure without dropping attribution", async () => {
    const broken = {
      from: () => ({ select: () => ({ in: async () => { throw new Error("boom"); } }) }),
    } as unknown as SupabaseClient;
    const out = await buildAttribution(broken, [
      { work_order_id: "wo6", kind: "internal", created_by_user_id: "u-amy", opened_at: null, submitted_at: "2026-08-14T10:00:00Z" },
    ]);
    expect(out.get("wo6")).toMatchObject({ entryMode: "internal", submittedByName: "Internal entry" });
  });

  it("handles a token with no creator at all", async () => {
    const out = await buildAttribution(sb, [
      { work_order_id: "wo7", kind: null, created_by_user_id: null, opened_at: null, submitted_at: null },
    ]);
    expect(out.get("wo7")).toEqual({
      entryMode: "customer",
      sentByName: null,
      openedByName: null,
      submittedByName: null,
    });
  });
});
