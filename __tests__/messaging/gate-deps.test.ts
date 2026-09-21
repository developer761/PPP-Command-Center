import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { gateDeps, clearSuppressionListCache } from "@/lib/messaging/gate-deps";
import type { E164 } from "@/lib/messaging/phone";

/**
 * The three lookups the rails stand on.
 *
 * Every test here is about ONE question: what happens when the database does
 * not answer. postgrest-js does not throw — it returns `{ data: null, error }`
 * — so a lookup that destructures only `data` reads a failed query as an empty
 * result. For `isSuppressed` an empty result means "they never opted out", and
 * the gate sends. That is a refusal turning into permission because a
 * connection dropped, and it was the shape of this file until these tests.
 */

type Result = { data?: unknown; error?: unknown; count?: number | null };

/**
 * A Supabase stub that answers every chained query the same way.
 *
 * `await`ing a PostgREST builder resolves it, so the stub is thenable as well
 * as chainable — otherwise the non-maybeSingle queries hang rather than fail.
 */
function sbStub(result: Result, spy?: { calls: string[] }): SupabaseClient {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "ilike", "in", "gte", "lte", "limit", "order", "not", "neq"]) {
    chain[m] = (...args: unknown[]) => { spy?.calls.push(`${m}(${args.map(String).join(",")})`); return chain; };
  }
  chain.maybeSingle = async () => result;
  chain.single = async () => result;
  chain.then = (res: (v: Result) => unknown) => Promise.resolve(result).then(res);
  return { from: () => chain } as unknown as SupabaseClient;
}

const PHONE = "+15165550147" as E164;
const DB_DOWN = { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } };

beforeEach(() => {
  clearSuppressionListCache();
  delete process.env.SUPPRESSION_LIST_CONFIRMED_EMPTY;
});
afterEach(() => { clearSuppressionListCache(); });

describe("isSuppressed — a database that will not answer is not permission to text", () => {
  it("refuses to answer rather than claiming the number is clear (sms)", async () => {
    const deps = gateDeps(sbStub(DB_DOWN));
    // NOT `false`. Returning false here sends a message to somebody who may
    // have said STOP; the whole point of the rail is that we do not guess.
    await expect(deps.isSuppressed({ phone: PHONE, email: null }, "sms")).rejects.toThrow(/suppress/i);
  });

  it("refuses to answer rather than claiming the address is clear (email)", async () => {
    const deps = gateDeps(sbStub(DB_DOWN));
    await expect(deps.isSuppressed({ phone: null, email: "a@b.com" }, "email")).rejects.toThrow(/suppress/i);
  });

  it("still reports a real suppression as suppressed", async () => {
    const deps = gateDeps(sbStub({ data: [{ id: "x" }], error: null }));
    expect(await deps.isSuppressed({ phone: PHONE, email: null }, "sms")).toBe(true);
  });

  it("still reports a clear number as clear", async () => {
    const deps = gateDeps(sbStub({ data: [], error: null }));
    expect(await deps.isSuppressed({ phone: PHONE, email: null }, "sms")).toBe(false);
  });

  it("treats a missing identifier as suppressed, because there is nothing to send to", async () => {
    const deps = gateDeps(sbStub({ data: [], error: null }));
    expect(await deps.isSuppressed({ phone: null, email: null }, "sms")).toBe(true);
    expect(await deps.isSuppressed({ phone: null, email: null }, "email")).toBe(true);
  });
});

describe("isSuppressed — an email address is a value, not a pattern", () => {
  it("escapes LIKE wildcards in the address it looks up", async () => {
    const spy = { calls: [] as string[] };
    const deps = gateDeps(sbStub({ data: [], error: null }, spy));
    await deps.isSuppressed({ phone: null, email: "john_doe@example.com" }, "email");
    const ilike = spy.calls.find((c) => c.startsWith("ilike("));
    // Unescaped, `_` is LIKE's single-character wildcard: the lookup for
    // john_doe@example.com also matches johnxdoe@example.com. Over-matching
    // is not the danger — TWO matches was, see the next test.
    expect(ilike).toContain("john\\_doe@example.com");
  });

  it("does not read two matching suppressions as none", async () => {
    // maybeSingle() errors with PGRST116 when more than one row matches, and
    // `!!data` on that error read as "not suppressed" — so somebody who
    // unsubscribed got emailed BECAUSE a second similar address was on the
    // list. One match or ten, the answer is the same: suppressed.
    const many = { data: [{ id: "a" }, { id: "b" }], error: null };
    const deps = gateDeps(sbStub(many));
    expect(await deps.isSuppressed({ phone: null, email: "john_doe@example.com" }, "email")).toBe(true);
  });
});

describe("sentToday — the daily cap must not fail open", () => {
  it("refuses to answer when the conversation lookup fails", async () => {
    const deps = gateDeps(sbStub(DB_DOWN));
    // Answering 0 here says "they have had nothing today", which is how a
    // capped customer gets a fourth message.
    await expect(deps.sentToday!(PHONE)).rejects.toThrow(/cap|count/i);
  });

  it("counts nothing when the customer genuinely has no conversations", async () => {
    const deps = gateDeps(sbStub({ data: [], error: null, count: 0 }));
    expect(await deps.sentToday!(PHONE)).toBe(0);
  });

  it("returns the count when the database answers", async () => {
    const deps = gateDeps(sbStub({ data: [{ id: "c1" }], error: null, count: 2 }));
    expect(await deps.sentToday!(PHONE)).toBe(2);
  });
});

describe("hasEverSent — failing here is safe, and stays safe", () => {
  it("says no on a failed lookup, which appends the disclosure again", async () => {
    // The opposite direction from the rails above ON PURPOSE. Being wrong here
    // sends one extra "Reply STOP to opt out" to somebody who has seen it,
    // which is harmless; being wrong the other way omits a disclosure the law
    // requires on first contact.
    const deps = gateDeps(sbStub(DB_DOWN));
    expect(await deps.hasEverSent!(PHONE)).toBe(false);
  });
});

describe("suppressionListLoaded — the port rail", () => {
  it("is not loaded when the count fails", async () => {
    const deps = gateDeps(sbStub(DB_DOWN));
    expect(await deps.suppressionListLoaded!()).toBe(false);
  });

  it("counts only ACTIVE suppressions, not people who opted back in", async () => {
    const spy = { calls: [] as string[] };
    const deps = gateDeps(sbStub({ count: 5, error: null }, spy));
    await deps.suppressionListLoaded!();
    // A list of 200 rows where every one has opted back in is an EMPTY
    // suppression list, and the rail exists to refuse exactly that.
    expect(spy.calls.some((c) => c.startsWith("is(opted_in_at,null"))).toBe(true);
  });

  it("can be switched off deliberately, and only deliberately", async () => {
    process.env.SUPPRESSION_LIST_CONFIRMED_EMPTY = "true";
    expect(await gateDeps(sbStub(DB_DOWN)).suppressionListLoaded!()).toBe(true);
    process.env.SUPPRESSION_LIST_CONFIRMED_EMPTY = "1";
    clearSuppressionListCache();
    expect(await gateDeps(sbStub({ count: 0, error: null })).suppressionListLoaded!()).toBe(false);
  });
});
