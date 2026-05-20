import "server-only";

import { getSalesforceClient } from "@/lib/salesforce/client";

/**
 * Bulk Salesforce snapshot. One server-side fetch on each page load
 * (cached 5 min) gets every row we need to drive the entire dashboard.
 *
 * The client / pages then DERIVE per-period and per-rep views from this
 * snapshot — no further SF roundtrips on filter changes.
 *
 * This pattern wins three ways:
 *   1. Fewer SF roundtrips → page is much faster
 *   2. All derivations stay consistent (no "this card uses 30 days,
 *      that card uses 365 days" drift)
 *   3. Period changes are instant client-side recomputes
 */

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

export function clearSalesforceCache() {
  cache.clear();
}

/* ─────────────────────────────────────────────────────────────────
 * Snapshot shapes
 * ─────────────────────────────────────────────────────────────── */

export type SnapshotRep = {
  id: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  profileName: string | null;
  roleName: string | null;
  department: string | null;
  createdDate: string; // ISO
};

export type SnapshotOpp = {
  id: string;
  ownerId: string;
  accountName: string | null;
  amount: number;
  isClosed: boolean;
  isWon: boolean;
  stageName: string;
  createdDate: string; // ISO
  closeDate: string | null; // ISO date (YYYY-MM-DD typically)
  lastActivityDate: string | null; // ISO date — used for "at risk" detection
};

export type SalesforceSnapshot = {
  reps: SnapshotRep[];
  opportunities: SnapshotOpp[];
  fetchedAt: string;
};

type SfUserRow = {
  Id: string;
  Name: string;
  FirstName: string | null;
  LastName: string | null;
  Email: string | null;
  IsActive: boolean;
  CreatedDate: string;
  UserType: string | null;
  Profile: { Name: string | null } | null;
  UserRole: { Name: string | null } | null;
  Department: string | null;
};

type SfOppRow = {
  Id: string;
  OwnerId: string;
  Account: { Name: string | null } | null;
  Amount: number | null;
  Quoted_Subtotal_with_Change_Order__c: number | null;
  Net_Value__c: number | null;
  IsClosed: boolean;
  IsWon: boolean;
  StageName: string;
  CreatedDate: string;
  CloseDate: string | null;
  LastActivityDate: string | null;
};

/** Identify "real reps" vs system / admin / portal / integration users. */
function isLikelyRep(profileName: string | null, isActive: boolean): boolean {
  if (!isActive) return false;
  if (!profileName) return true; // permissive — if no profile, give them benefit of doubt
  const p = profileName.toLowerCase();
  const skip = [
    "system administrator",
    "marketing user",
    "read only",
    "chatter only",
    "chatter free",
    "chatter external",
    "high volume customer portal",
    "customer community",
    "partner community",
    "integration",
    "automated process",
    "guest license",
    "platform integration",
  ];
  return !skip.some((tok) => p.includes(tok));
}

/* ─────────────────────────────────────────────────────────────────
 * Public — one bulk snapshot fetch, parallel queries
 * ─────────────────────────────────────────────────────────────── */

export async function loadSalesforceSnapshot(): Promise<SalesforceSnapshot> {
  return cached("snapshot", async () => {
    const conn = await getSalesforceClient();

    // Run both queries in parallel — saves ~half the wall time.
    //
    // Opportunity revenue: PPP doesn't populate the standard `Amount` field.
    // Their report ("Opportunities with Work Orders") uses two custom fields:
    //   - Net_Value__c — the realized revenue figure (matches "Sum of Net Value" in the report)
    //   - Quoted_Subtotal_with_Change_Order__c — gross quoted value before adjustments
    // We try both; SF returns null for whichever is empty on a given record.
    // If either field name is wrong, the query errors and we fall back to a
    // narrower query (see catch block).
    const usersPromise = conn.query<SfUserRow>(`
      SELECT Id, Name, FirstName, LastName, Email, IsActive, CreatedDate,
             UserType, Profile.Name, UserRole.Name, Department
      FROM User
      WHERE IsActive = true
      LIMIT 500
    `);

    let oppsResult;
    try {
      oppsResult = await conn.query<SfOppRow>(`
        SELECT Id, OwnerId, Account.Name, Amount,
               Quoted_Subtotal_with_Change_Order__c, Net_Value__c,
               IsClosed, IsWon, StageName,
               CreatedDate, CloseDate, LastActivityDate
        FROM Opportunity
        WHERE CreatedDate = LAST_N_DAYS:730
        LIMIT 5000
      `);
    } catch (err) {
      // Fall back: query without the custom revenue fields if PPP names them differently.
      // Log the failure so we can see in Vercel logs which field is missing.
      console.error("[SF] Custom revenue field query failed — falling back to Amount only:", err);
      const fallback = await conn.query<Omit<SfOppRow, "Quoted_Subtotal_with_Change_Order__c" | "Net_Value__c">>(`
        SELECT Id, OwnerId, Account.Name, Amount, IsClosed, IsWon, StageName,
               CreatedDate, CloseDate, LastActivityDate
        FROM Opportunity
        WHERE CreatedDate = LAST_N_DAYS:730
        LIMIT 5000
      `);
      oppsResult = {
        ...fallback,
        records: fallback.records.map((r) => ({
          ...r,
          Quoted_Subtotal_with_Change_Order__c: null,
          Net_Value__c: null,
        })),
      };
    }
    const usersResult = await usersPromise;

    const reps: SnapshotRep[] = usersResult.records
      .filter((u) => u.UserType === "Standard" || u.UserType === "PowerPartner" || u.UserType === null)
      .filter((u) => isLikelyRep(u.Profile?.Name ?? null, u.IsActive))
      .map((u) => ({
        id: u.Id,
        name: u.Name,
        firstName: u.FirstName,
        lastName: u.LastName,
        email: u.Email,
        profileName: u.Profile?.Name ?? null,
        roleName: u.UserRole?.Name ?? null,
        department: u.Department,
        createdDate: u.CreatedDate,
      }));

    const opportunities: SnapshotOpp[] = oppsResult.records.map((o) => ({
      id: o.Id,
      ownerId: o.OwnerId,
      accountName: o.Account?.Name ?? null,
      // Use Net_Value first (matches PPP's report total of $1.26M), then
      // Quoted_Subtotal_with_Change_Order ($1.31M), then Amount as last resort.
      // The standard Amount field is mostly null in PPP's org per the report.
      amount: o.Net_Value__c ?? o.Quoted_Subtotal_with_Change_Order__c ?? o.Amount ?? 0,
      isClosed: o.IsClosed,
      isWon: o.IsWon,
      stageName: o.StageName,
      createdDate: o.CreatedDate,
      closeDate: o.CloseDate,
      lastActivityDate: o.LastActivityDate,
    }));

    return {
      reps,
      opportunities,
      fetchedAt: new Date().toISOString(),
    };
  });
}

/** Lightweight summary for the integrations dashboard. */
export async function getSalesforceDataSummary() {
  const snap = await loadSalesforceSnapshot();
  return {
    users: snap.reps.length,
    accounts: new Set(snap.opportunities.map((o) => o.accountName).filter(Boolean)).size,
    opportunities: snap.opportunities.length,
    workOrders: 0, // TBD
  };
}

/* ─────────────────────────────────────────────────────────────────
 * Schema Inspector — list custom fields on key objects.
 * Use this when the dashboard shows wrong values: load this on the
 * Integrations page to see the actual API names of PPP's custom
 * fields, then update queries.ts to use them.
 * ─────────────────────────────────────────────────────────────── */

export type SchemaInspection = {
  object: string;
  total: number;
  customFields: Array<{ name: string; label: string; type: string }>;
  sampleRecord: Record<string, unknown> | null;
  totalRecords: number;
  error?: string;
};

export async function describeKeySObjects(): Promise<SchemaInspection[]> {
  return cached("schema-inspection", async () => {
    const conn = await getSalesforceClient();
    const objects = ["Opportunity", "Account", "WorkOrder", "Work_Order__c", "Quote"];
    const out: SchemaInspection[] = [];

    for (const obj of objects) {
      try {
        const meta = await conn.sobject(obj).describe();
        const customFields = meta.fields
          .filter((f) => f.custom)
          .map((f) => ({ name: f.name, label: f.label, type: f.type }))
          .sort((a, b) => a.name.localeCompare(b.name));

        // Pull one record so we can see what custom fields actually contain values.
        let sampleRecord: Record<string, unknown> | null = null;
        let totalRecords = 0;
        try {
          const customNames = customFields.slice(0, 30).map((f) => f.name).join(", ");
          const sample = await conn.query<Record<string, unknown>>(
            customNames
              ? `SELECT Id, ${customNames} FROM ${obj} LIMIT 1`
              : `SELECT Id FROM ${obj} LIMIT 1`
          );
          sampleRecord = sample.records[0] ?? null;
          const countResult = await conn.query<{ cnt: number }>(`SELECT COUNT(Id) cnt FROM ${obj}`);
          totalRecords = countResult.records[0]?.cnt ?? 0;
        } catch {
          // Sample query may fail; not fatal for the inspection.
        }

        out.push({
          object: obj,
          total: meta.fields.length,
          customFields,
          sampleRecord,
          totalRecords,
        });
      } catch (err) {
        out.push({
          object: obj,
          total: 0,
          customFields: [],
          sampleRecord: null,
          totalRecords: 0,
          error: err instanceof Error ? err.message : "unknown",
        });
      }
    }

    return out;
  });
}
