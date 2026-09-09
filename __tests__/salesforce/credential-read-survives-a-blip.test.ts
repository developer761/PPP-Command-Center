import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * INCIDENT 2026-09-09 — Katie forwarded a failure on WO #00317112:
 *   "SF_CLIENT_INIT_FAILED — Failed to read SF credentials: Gateway Timeout"
 *
 * Salesforce was healthy. The Supabase read of `system_credentials` timed out,
 * and because every SF client construction re-read that table, a customer's
 * colors write was lost — after one of the two writes had already landed.
 *
 * Drives the REAL getStoredSalesforceCredentials with only the Supabase client
 * stubbed. Each test is written to FAIL against the pre-fix code (one read, no
 * retry, no cache, throw on error); see the header comment in client.ts.
 */

const GOOD = [
  { key: "sf_refresh_token", value: "refresh-abc" },
  { key: "sf_instance_url", value: "https://ppp.my.salesforce.com" },
  { key: "sf_connected_at", value: "2026-05-20T00:00:00Z" },
];

/**
 * A stub whose failure mode is MUTABLE, so a test can prime the cache with a
 * healthy read and then take the table down — which is the actual incident
 * shape, and is not expressible with a fixed-behaviour mock.
 */
function stubSupabase() {
  const state = { reads: 0, failuresLeft: 0, failAll: false };
  const client = {
    from() {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        in: async () => {
          state.reads++;
          if (state.failAll || state.failuresLeft > 0) {
            if (!state.failAll) state.failuresLeft--;
            return { data: null, error: { message: "Gateway Timeout" } };
          }
          return { data: GOOD, error: null };
        },
      });
      return chain;
    },
  };
  vi.doMock("@supabase/supabase-js", () => ({ createClient: () => client }));
  return state;
}

async function freshModule(state: ReturnType<typeof stubSupabase>) {
  void state;
  return import("@/lib/salesforce/client");
}

beforeEach(() => {
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "stub-key";
});

describe("SF credential read survives a Supabase blip", () => {
  it("retries a transient failure instead of failing the write", async () => {
    const state = stubSupabase();
    state.failuresLeft = 2;
    const { getStoredSalesforceCredentials } = await freshModule(state);

    const creds = await getStoredSalesforceCredentials();

    expect(creds?.refreshToken).toBe("refresh-abc");
    expect(state.reads).toBe(3); // pre-fix: 1 read, then throw
  });

  it("falls back to the last known good value when Supabase stays down", async () => {
    const state = stubSupabase();
    const mod = await freshModule(state);

    // Prime with a healthy read — this is the instance having served traffic.
    expect((await mod.getStoredSalesforceCredentials())?.refreshToken).toBe("refresh-abc");
    mod.clearSalesforceCredentialsCache(); // TTL expiry, simulated

    // Now the table goes down and STAYS down — the incident.
    state.failAll = true;
    const readsBefore = state.reads;

    const creds = await mod.getStoredSalesforceCredentials();

    expect(creds?.refreshToken).toBe("refresh-abc"); // the write survives
    expect(state.reads).toBe(readsBefore + 3); // it genuinely retried first
  });

  it("caches, so 23 client constructions are not 23 table reads", async () => {
    const state = stubSupabase();
    const { getStoredSalesforceCredentials } = await freshModule(state);

    for (let i = 0; i < 23; i++) await getStoredSalesforceCredentials();

    expect(state.reads).toBe(1); // pre-fix: 23 — the incident's blast radius
  });

  it("still throws when it has never had a good value to fall back on", async () => {
    const state = stubSupabase();
    state.failAll = true;
    const { getStoredSalesforceCredentials } = await freshModule(state);

    // A cold instance with a genuinely unreachable table must NOT pretend to
    // be connected — silently returning null here would read as "SF not set
    // up yet" and skip the writeback entirely.
    await expect(getStoredSalesforceCredentials()).rejects.toThrow(/Gateway Timeout/);
  });

  it("a fresh OAuth dance invalidates the cache", async () => {
    const state = stubSupabase();
    const mod = await freshModule(state);

    await mod.getStoredSalesforceCredentials();
    const readsBefore = state.reads;
    mod.clearSalesforceCredentialsCache();
    await mod.getStoredSalesforceCredentials();

    expect(state.reads).toBe(readsBefore + 1); // stale token would be a lockout
  });
});

describe("the failure alert names the layer that actually broke", () => {
  it("classifies Katie's actual error as transport, not a Salesforce auth problem", async () => {
    const { isTransportFailure } = await import("@/lib/salesforce/writeback");

    // The exact string from the WO #00317112 alert.
    expect(isTransportFailure("Failed to read SF credentials: Gateway Timeout")).toBe(true);

    for (const msg of ["ETIMEDOUT", "fetch failed", "socket hang up", "HTTP 504", "request timed out"]) {
      expect(isTransportFailure(msg), msg).toBe(true);
    }
    // A genuine auth failure must still route to "reconnect Salesforce".
    for (const msg of [
      "INVALID_SESSION_ID: Session expired or invalid",
      "expired authorization code",
      "INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY",
    ]) {
      expect(isTransportFailure(msg), msg).toBe(false);
    }
  });
});
