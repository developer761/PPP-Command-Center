import "server-only";

import { getSalesforceClient } from "@/lib/salesforce/client";
import type { Rep } from "@/lib/mock-data";

/**
 * SOQL query layer. Returns PPP-shaped data (compatible with the existing
 * mock-data exports) so the UI doesn't have to care whether it's SF or mock.
 *
 * Defensive against:
 *   - Empty sandbox (returns empty arrays, not errors)
 *   - Missing custom fields (falls back to defaults — Residential, Suffolk, etc.)
 *   - Non-rep users (filters by profile + by having Opportunities)
 *   - Inactive users
 */

/* ─────────────────────────────────────────────────────────────────
 * Lightweight per-request cache (5-min TTL).
 *
 * Why: dashboard re-renders on every filter dropdown change. Without a
 * cache, we'd run several SOQL queries on every interaction. SF rate
 * limits are generous but not infinite. 5 minutes is a good balance —
 * fresh enough for dashboard analytics, slow enough to not thrash SF.
 * ─────────────────────────────────────────────────────────────── */

const CACHE_TTL_MS = 5 * 60 * 1000;
type CacheEntry<T> = { value: T; expiresAt: number };
const cache = new Map<string, CacheEntry<unknown>>();

async function cached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value as T;
  const value = await fetcher();
  cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

/** Force-clear the cache. Useful after a reconnect or admin action. */
export function clearSalesforceCache() {
  cache.clear();
}

/* ─────────────────────────────────────────────────────────────────
 * SOQL helpers
 * ─────────────────────────────────────────────────────────────── */

type SfUser = {
  Id: string;
  Name: string;
  FirstName: string | null;
  LastName: string | null;
  Email: string | null;
  IsActive: boolean;
  CreatedDate: string;
  Profile: { Name: string | null } | null;
  UserRole: { Name: string | null } | null;
  Department: string | null;
};

type OppAgg = {
  OwnerId: string;
  cnt: number;
  total: number;
  won: number;
  wonRevenue: number;
};

/** Best-effort region mapping. PPP-specific; refine when we know their schema. */
function deriveRegion(user: SfUser): Rep["region"] {
  const role = user.UserRole?.Name?.toLowerCase() ?? "";
  const dept = user.Department?.toLowerCase() ?? "";
  const probe = `${role} ${dept}`;
  if (probe.includes("suffolk")) return "Suffolk";
  if (probe.includes("nassau")) return "Nassau";
  if (probe.includes("queens")) return "Queens";
  if (probe.includes("brooklyn")) return "Brooklyn";
  // Default — at least the dashboard renders. Real region mapping comes when
  // we know what field PPP uses (likely a custom Region__c on User or a
  // Service_Territory__c lookup on Opportunity).
  return "Suffolk";
}

/** Best-effort service line. Without a User-level field, default to Residential. */
function deriveServiceLine(user: SfUser): Rep["serviceLine"] {
  const role = user.UserRole?.Name?.toLowerCase() ?? "";
  if (role.includes("commercial")) return "Commercial";
  return "Residential";
}

/** Detect "real reps" vs system / admin / portal users.
 *
 * Heuristic: skip Profile names that contain Admin / System / Integration / Portal /
 * Chatter. Otherwise treat as a candidate rep. Will tighten once we see PPP's
 * actual Profile names.
 */
function isLikelyRep(user: SfUser): boolean {
  if (!user.IsActive) return false;
  const profile = user.Profile?.Name?.toLowerCase() ?? "";
  const skip = ["admin", "system", "integration", "portal", "chatter", "guest", "automated"];
  return !skip.some((token) => profile.includes(token));
}

/* ─────────────────────────────────────────────────────────────────
 * Public API — used by data-source.ts
 * ─────────────────────────────────────────────────────────────── */

export async function getRepsFromSalesforce(): Promise<Rep[]> {
  return cached("reps", async () => {
    const conn = await getSalesforceClient();

    // 1. All active standard users (broad — we'll filter to "real reps" in code)
    const usersResult = await conn.query<SfUser>(`
      SELECT Id, Name, FirstName, LastName, Email, IsActive, CreatedDate,
             Profile.Name, UserRole.Name, Department
      FROM User
      WHERE IsActive = true
        AND UserType = 'Standard'
      LIMIT 200
    `);
    const allUsers = usersResult.records;
    const candidateReps = allUsers.filter(isLikelyRep);

    if (candidateReps.length === 0) return [];

    const candidateIds = candidateReps.map((u) => `'${u.Id}'`).join(",");

    // 2. Opportunity aggregates per owner — last 365 days
    type OppRow = {
      OwnerId: string;
      Id: string;
      Amount: number | null;
      IsWon: boolean;
      IsClosed: boolean;
      CreatedDate: string;
      CloseDate: string | null;
    };

    const oppsResult = await conn.query<OppRow>(`
      SELECT OwnerId, Id, Amount, IsWon, IsClosed, CreatedDate, CloseDate
      FROM Opportunity
      WHERE OwnerId IN (${candidateIds})
        AND CreatedDate = LAST_N_DAYS:365
      LIMIT 5000
    `);
    const opps = oppsResult.records;

    // Aggregate per OwnerId in code (more flexible than SOQL GROUP BY for our shape)
    const aggByOwner = new Map<string, {
      total: number;
      closed: number;
      won: number;
      wonRevenue: number;
      openPipeline: number;
      daysToCloseSum: number;
      daysToCloseCount: number;
      ticketSum: number;
      ticketCount: number;
    }>();

    for (const o of opps) {
      const a = aggByOwner.get(o.OwnerId) ?? {
        total: 0, closed: 0, won: 0, wonRevenue: 0, openPipeline: 0,
        daysToCloseSum: 0, daysToCloseCount: 0, ticketSum: 0, ticketCount: 0,
      };
      a.total += 1;
      if (o.IsClosed) a.closed += 1;
      if (o.IsWon) {
        a.won += 1;
        a.wonRevenue += o.Amount ?? 0;
        a.ticketSum += o.Amount ?? 0;
        a.ticketCount += 1;
        if (o.CloseDate) {
          const created = new Date(o.CreatedDate).getTime();
          const closed = new Date(o.CloseDate).getTime();
          a.daysToCloseSum += Math.max(0, Math.round((closed - created) / 86_400_000));
          a.daysToCloseCount += 1;
        }
      }
      if (!o.IsClosed) a.openPipeline += o.Amount ?? 0;
      aggByOwner.set(o.OwnerId, a);
    }

    // 3. Build Rep[] in the shape the UI expects
    const reps: Rep[] = candidateReps.map((u) => {
      const a = aggByOwner.get(u.Id) ?? {
        total: 0, closed: 0, won: 0, wonRevenue: 0, openPipeline: 0,
        daysToCloseSum: 0, daysToCloseCount: 0, ticketSum: 0, ticketCount: 0,
      };
      const closeRate = a.closed > 0 ? (a.won / a.closed) * 100 : 0;
      const avgTicket = a.ticketCount > 0 ? a.ticketSum / a.ticketCount : 0;
      const daysAvgClose = a.daysToCloseCount > 0
        ? Math.round(a.daysToCloseSum / a.daysToCloseCount)
        : 0;

      return {
        id: u.Id,
        name: u.Name,
        region: deriveRegion(u),
        serviceLine: deriveServiceLine(u),
        revenueSold: Math.round(a.wonRevenue / 1000), // $K (UI expects K units)
        closeRate: +closeRate.toFixed(1),
        avgTicket: +(avgTicket / 1000).toFixed(1), // $K
        openPipeline: Math.round(a.openPipeline / 1000), // $K
        daysAvgClose,
        appointmentsHeld: 0, // TBD — needs Service_Appointment__c query
        quotesSent: a.total, // proxy: total Opportunities = quotes sent
        startedAt: u.CreatedDate.split("T")[0], // YYYY-MM-DD
      };
    });

    // Sort by revenue, only include reps with SOME activity (filters out brand new admin-promoted reps)
    return reps
      .filter((r) => r.revenueSold > 0 || r.openPipeline > 0 || r.quotesSent > 0)
      .sort((a, b) => b.revenueSold - a.revenueSold);
  });
}

/** Quick proof-of-life query — returns counts so we can confirm the sandbox isn't empty. */
export async function getSalesforceDataSummary() {
  return cached("data-summary", async () => {
    const conn = await getSalesforceClient();
    const [users, accounts, opps, workOrders] = await Promise.all([
      conn.query<{ cnt: number }>(`SELECT COUNT(Id) cnt FROM User WHERE IsActive = true AND UserType = 'Standard'`),
      conn.query<{ cnt: number }>(`SELECT COUNT(Id) cnt FROM Account`),
      conn.query<{ cnt: number }>(`SELECT COUNT(Id) cnt FROM Opportunity`),
      // Work_Order__c might not exist or might be named differently — try, swallow error
      conn
        .query<{ cnt: number }>(`SELECT COUNT(Id) cnt FROM WorkOrder`)
        .then((r) => r.records[0]?.cnt ?? 0)
        .catch(() => 0),
    ]);
    return {
      users: users.records[0]?.cnt ?? 0,
      accounts: accounts.records[0]?.cnt ?? 0,
      opportunities: opps.records[0]?.cnt ?? 0,
      workOrders: typeof workOrders === "number" ? workOrders : 0,
    };
  });
}
