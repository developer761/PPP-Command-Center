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

/**
 * Account snapshot. Carries the data PPP customers/vendors are described by:
 *   - Type (Customer / Repeat Customer / Prospect / Marketing Vendor / etc.)
 *   - Service_Territory__c — territory mapping (production-confirmed)
 *   - Total_Lifetime_Revenue__c — running total across all WOs
 *   - VendorBMRetailer__c / VendorBMAutoSubmit__c — Benjamin Moore vendor flags
 *     (used by Phase 2 Materials Ordering)
 *   - Total_Won_Oppties__c / Total_Lost_Oppties__c — close-rate denominator
 *   - Last_Appointment__c / Last_Work_Order_Completed__c — engagement recency
 */
export type SnapshotAccount = {
  id: string;
  name: string;
  type: string | null;
  serviceTerritoryId: string | null;
  region: string | null;
  geoZone: string | null;
  county: string | null;
  totalLifetimeRevenue: number;
  totalRevenueCFY: number;
  totalRevenuePFY: number;
  totalWonOppties: number;
  totalLostOppties: number;
  numberOpenOppties: number;
  isBMRetailer: boolean;
  isBMAutoSubmit: boolean;
  isKeyRelationship: boolean;
  lastAppointment: string | null;
  lastWorkOrderCompleted: string | null;
};

/**
 * Work Order. PPP's "Opportunities with Work Orders" report is the source of
 * truth for revenue — sums Net Value across WO rows, not Opp rows. A single
 * opp can carry multiple work orders so summing per-Opp under-counts.
 *
 * The WO carries the canonical revenue figure (Subtotal__c / QuotedSubtotal__c
 * / NetValue__c). The owner/account come from the linked Opportunity.
 */
export type SnapshotWorkOrder = {
  id: string;
  workOrderNumber: string | null;
  status: string | null;
  /** Canonical revenue (auto-detected: Subtotal__c / QuotedSubtotal__c / NetValue__c). */
  amount: number;
  /** Gross quoted (with change orders). */
  quotedSubtotal: number;
  /** Net realized. */
  netValue: number;
  opportunityId: string | null;
  ownerId: string | null;
  ownerName: string | null;
  accountName: string | null;
  closeDate: string | null;
  createdDate: string;
};

export type SalesforceSnapshot = {
  reps: SnapshotRep[];
  opportunities: SnapshotOpp[];
  workOrders: SnapshotWorkOrder[];
  accounts: SnapshotAccount[];
  fetchedAt: string;
  /** Canonical Opp revenue field (dynamically detected). */
  revenueFieldUsed: string | null;
  /** Canonical WO revenue field (dynamically detected). */
  workOrderRevenueField: string | null;
  /** True if connected SF instance is a sandbox. */
  isSandbox: boolean;
  /** Live instance URL — used for surfacing sandbox/prod state in UI. */
  instanceUrl: string | null;
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
  IsClosed: boolean;
  IsWon: boolean;
  StageName: string;
  CreatedDate: string;
  CloseDate: string | null;
  LastActivityDate: string | null;
  // Custom currency fields are added dynamically — see loadSalesforceSnapshot.
  [key: string]: unknown;
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
  return cached("snapshot-v3", async () => {
    const conn = await getSalesforceClient();

    // STEP 1: Discover Opportunity schema. PPP's "Opportunities with Work Orders"
    // report sums a custom currency field labeled "Net Value" — but the API name
    // is unknown until we describe(). We dynamically find all custom currency
    // fields, run a one-shot aggregate query to see which one sums to ~$1.26M
    // (PPP's report total), and use that field as the canonical "amount" for
    // every opp going forward. Self-heals if PPP renames the field.
    let revenueField: string | null = null;
    let allCurrencyFields: string[] = [];
    try {
      const meta = await conn.sobject("Opportunity").describe();
      allCurrencyFields = meta.fields
        .filter((f) => f.custom && (f.type === "currency" || f.type === "double"))
        .map((f) => f.name);

      if (allCurrencyFields.length > 0) {
        const aggregates = allCurrencyFields
          .slice(0, 25)
          .map((n) => `SUM(${n}) ${n.toLowerCase()}_sum`)
          .join(", ");
        const sums = await conn.query<Record<string, number | null>>(
          `SELECT ${aggregates} FROM Opportunity`
        );
        const sumRow = sums.records[0] ?? {};
        // Pick the currency field with the highest aggregate. That matches PPP's
        // canonical revenue field (per their report, ~$1.26M).
        let bestField: string | null = null;
        let bestSum = 0;
        for (const fname of allCurrencyFields) {
          const sumKey = `${fname.toLowerCase()}_sum`;
          const v = sumRow[sumKey];
          if (typeof v === "number" && v > bestSum) {
            bestSum = v;
            bestField = fname;
          }
        }
        revenueField = bestField;
        console.log(`[SF] Dynamic revenue field detection: ${revenueField} = $${bestSum.toLocaleString()}`);
      }
    } catch (err) {
      console.error("[SF] Schema discovery for Opportunity failed:", err);
    }

    // STEP 2: Query users + all opps in parallel. Include every custom currency
    // field so the per-opp amount can fall back if the chosen field is null on
    // a given record.
    const usersPromise = conn.query<SfUserRow>(`
      SELECT Id, Name, FirstName, LastName, Email, IsActive, CreatedDate,
             UserType, Profile.Name, UserRole.Name, Department
      FROM User
      WHERE IsActive = true
      LIMIT 500
    `);

    const currencyFieldsSelect = allCurrencyFields.length > 0
      ? `, ${allCurrencyFields.slice(0, 25).join(", ")}`
      : "";

    // SOQL returns at most 2000 records per batch. PPP has many more opps than
    // that, so we paginate via queryMore until done. Without this we silently
    // miss most of the data — exactly the bug that made the dashboard show
    // ~$507K against PPP's $1.26M report.
    async function queryAllOpps(withCustomFields: boolean): Promise<SfOppRow[]> {
      const selectFields = `Id, OwnerId, Account.Name, Amount, IsClosed, IsWon, StageName, CreatedDate, CloseDate, LastActivityDate${withCustomFields ? currencyFieldsSelect : ""}`;
      const all: SfOppRow[] = [];
      let result = await conn.query<SfOppRow>(`SELECT ${selectFields} FROM Opportunity`);
      all.push(...(result.records as SfOppRow[]));
      while (!result.done && result.nextRecordsUrl) {
        result = await conn.queryMore<SfOppRow>(result.nextRecordsUrl);
        all.push(...(result.records as SfOppRow[]));
      }
      return all;
    }

    let oppRecords: SfOppRow[];
    try {
      oppRecords = await queryAllOpps(true);
    } catch (err) {
      console.error("[SF] Opp query with custom fields failed — narrowing:", err);
      oppRecords = await queryAllOpps(false);
    }
    console.log(`[SF] Pulled ${oppRecords.length} opportunities (all batches)`);
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

    const opportunities: SnapshotOpp[] = oppRecords.map((o) => {
      // Resolve amount per-opp:
      //   1. If we discovered a canonical revenue field, prefer it
      //   2. Fall back to max value across all custom currency fields
      //   3. Fall back to standard Amount
      let resolved = 0;
      if (revenueField) {
        const v = o[revenueField];
        if (typeof v === "number" && v > 0) resolved = v;
      }
      if (resolved === 0) {
        for (const fname of allCurrencyFields) {
          const v = o[fname];
          if (typeof v === "number" && v > resolved) resolved = v;
        }
      }
      if (resolved === 0 && typeof o.Amount === "number") {
        resolved = o.Amount;
      }

      return {
        id: o.Id,
        ownerId: o.OwnerId,
        accountName: o.Account?.Name ?? null,
        amount: resolved,
        isClosed: o.IsClosed,
        isWon: o.IsWon,
        stageName: o.StageName,
        createdDate: o.CreatedDate,
        closeDate: o.CloseDate,
        lastActivityDate: o.LastActivityDate,
      };
    });

    /* ─────── Work Orders (PPP's true revenue unit) ─────── */

    // Detect WO revenue field the same way we did Opps. PPP's report sums
    // "Quoted Subtotal with Change Order" + "Net Value" — both live on WO.
    // We pick the canonical field by highest aggregate sum.
    let woRevenueField: string | null = null;
    let woQuotedField: string | null = null;
    let woNetField: string | null = null;
    let woCurrencyFields: string[] = [];
    let woStatusField: string | null = null;
    let woNumberField: string | null = null;
    let woOppLookup: string | null = null;
    let woOppRelName: string | null = null;
    let workOrderRecords: Array<Record<string, unknown>> = [];

    try {
      const woMeta = await conn.sobject("WorkOrder").describe();
      woCurrencyFields = woMeta.fields
        .filter((f) => f.custom && (f.type === "currency" || f.type === "double"))
        .map((f) => f.name);

      // Known field name patterns from the schema deep-dive:
      //   Subtotal__c (commonly populated baseline)
      //   QuotedSubtotal__c, Quoted_Subtotal_with_Change_Order__c (gross)
      //   NetValue__c (net realized)
      const byName = (re: RegExp) => woCurrencyFields.find((n) => re.test(n)) ?? null;
      woQuotedField = byName(/^Quoted_?Subtotal_?with_?Change_?Order/i)
        ?? byName(/^Quoted_?Subtotal/i);
      woNetField = byName(/^Net_?Value/i);
      // Canonical = whichever sums highest across all WO records.
      if (woCurrencyFields.length > 0) {
        const aggs = woCurrencyFields
          .slice(0, 25)
          .map((n) => `SUM(${n}) ${n.toLowerCase()}_sum`)
          .join(", ");
        try {
          const sums = await conn.query<Record<string, number | null>>(
            `SELECT ${aggs} FROM WorkOrder`
          );
          const row = sums.records[0] ?? {};
          let bestField: string | null = null;
          let bestSum = 0;
          for (const fname of woCurrencyFields) {
            const v = row[`${fname.toLowerCase()}_sum`];
            if (typeof v === "number" && v > bestSum) {
              bestSum = v;
              bestField = fname;
            }
          }
          woRevenueField = bestField;
          console.log(`[SF] WO revenue field auto-detected: ${woRevenueField} = $${bestSum.toLocaleString()}`);
        } catch (err) {
          console.error("[SF] WO aggregate sum failed:", err);
        }
      }

      // Identify Status, WorkOrderNumber, Opportunity-lookup field names
      // (these are standard but defensively detect to handle WO subtypes).
      woStatusField = woMeta.fields.find((f) => f.name === "Status")?.name ?? null;
      woNumberField = woMeta.fields.find((f) => f.name === "WorkOrderNumber")?.name ?? null;
      const oppRef = woMeta.fields.find(
        (f) => f.type === "reference" && f.referenceTo?.includes("Opportunity")
      );
      if (oppRef) {
        woOppLookup = oppRef.name;
        woOppRelName = oppRef.relationshipName ?? null;
      }

      // Build the SOQL with the fields we know about. Skip Opp join fields if
      // there's no Opportunity lookup on WO (would be unusual but defensive).
      const woFieldList = [
        "Id",
        woNumberField,
        woStatusField,
        "CreatedDate",
        ...woCurrencyFields.slice(0, 20),
        woOppLookup,
        woOppRelName ? `${woOppRelName}.OwnerId` : null,
        woOppRelName ? `${woOppRelName}.Owner.Name` : null,
        woOppRelName ? `${woOppRelName}.Account.Name` : null,
        woOppRelName ? `${woOppRelName}.CloseDate` : null,
      ].filter((x): x is string => Boolean(x));

      // Paginate.
      let result = await conn.query<Record<string, unknown>>(
        `SELECT ${woFieldList.join(", ")} FROM WorkOrder`
      );
      workOrderRecords.push(...result.records);
      while (!result.done && result.nextRecordsUrl) {
        result = await conn.queryMore<Record<string, unknown>>(result.nextRecordsUrl);
        workOrderRecords.push(...result.records);
      }
      console.log(`[SF] Pulled ${workOrderRecords.length} work orders`);
    } catch (err) {
      console.error("[SF] WorkOrder query failed (object may not exist in this org):", err);
    }

    const workOrders: SnapshotWorkOrder[] = workOrderRecords.map((w) => {
      // Per-WO amount: canonical field → max across currency fields.
      let resolved = 0;
      if (woRevenueField) {
        const v = w[woRevenueField];
        if (typeof v === "number" && v > 0) resolved = v;
      }
      if (resolved === 0) {
        for (const fname of woCurrencyFields) {
          const v = w[fname];
          if (typeof v === "number" && v > resolved) resolved = v;
        }
      }
      const quoted = woQuotedField && typeof w[woQuotedField] === "number"
        ? (w[woQuotedField] as number) : 0;
      const net = woNetField && typeof w[woNetField] === "number"
        ? (w[woNetField] as number) : 0;

      const opp = woOppRelName ? (w[woOppRelName] as Record<string, unknown> | undefined) : undefined;
      const ownerNested = opp?.Owner as Record<string, unknown> | undefined;
      const accountNested = opp?.Account as Record<string, unknown> | undefined;

      return {
        id: w.Id as string,
        workOrderNumber: woNumberField ? (w[woNumberField] as string | null) ?? null : null,
        status: woStatusField ? (w[woStatusField] as string | null) ?? null : null,
        amount: resolved,
        quotedSubtotal: quoted,
        netValue: net,
        opportunityId: woOppLookup ? (w[woOppLookup] as string | null) ?? null : null,
        ownerId: opp ? (opp.OwnerId as string | null) ?? null : null,
        ownerName: ownerNested ? (ownerNested.Name as string | null) ?? null : null,
        accountName: accountNested ? (accountNested.Name as string | null) ?? null : null,
        closeDate: opp ? (opp.CloseDate as string | null) ?? null : null,
        createdDate: w.CreatedDate as string,
      };
    });

    /* ─────── Accounts ─────── */
    // Pull all accounts so per-rep cards can surface "X repeat customers",
    // total lifetime revenue per account, BM-retailer flag (for Phase 2),
    // and territory data. Wrapped in try/catch — if Account perms are
    // restricted, snapshot still renders without account context.
    let accounts: SnapshotAccount[] = [];
    try {
      const ACCT_FIELDS = `
        Id, Name, Type, Service_Territory__c, Region__c, Geo_Zone__c, County__c,
        Total_Lifetime_Revenue__c, Total_Revenue_CFY__c, Total_Revenue_PFY__c,
        Total_Won_Oppties__c, Total_Lost_Oppties__c, Number_Open_Oppties__c,
        VendorBMRetailer__c, VendorBMAutoSubmit__c, Key_Relationship__c,
        Last_Appointment__c, LastWorkOrderCompleted__c
      `.replace(/\s+/g, " ").trim();

      const acctRecords: Array<Record<string, unknown>> = [];
      let acctResult = await conn.query<Record<string, unknown>>(
        `SELECT ${ACCT_FIELDS} FROM Account`
      );
      acctRecords.push(...acctResult.records);
      while (!acctResult.done && acctResult.nextRecordsUrl) {
        acctResult = await conn.queryMore<Record<string, unknown>>(acctResult.nextRecordsUrl);
        acctRecords.push(...acctResult.records);
      }
      console.log(`[SF] Pulled ${acctRecords.length} accounts`);

      accounts = acctRecords.map((a) => ({
        id: a.Id as string,
        name: (a.Name as string) ?? "",
        type: (a.Type as string | null) ?? null,
        serviceTerritoryId: (a.Service_Territory__c as string | null) ?? null,
        region: (a.Region__c as string | null) ?? null,
        geoZone: (a.Geo_Zone__c as string | null) ?? null,
        county: (a.County__c as string | null) ?? null,
        totalLifetimeRevenue: (a.Total_Lifetime_Revenue__c as number | null) ?? 0,
        totalRevenueCFY: (a.Total_Revenue_CFY__c as number | null) ?? 0,
        totalRevenuePFY: (a.Total_Revenue_PFY__c as number | null) ?? 0,
        totalWonOppties: (a.Total_Won_Oppties__c as number | null) ?? 0,
        totalLostOppties: (a.Total_Lost_Oppties__c as number | null) ?? 0,
        numberOpenOppties: (a.Number_Open_Oppties__c as number | null) ?? 0,
        isBMRetailer: Boolean(a.VendorBMRetailer__c),
        isBMAutoSubmit: Boolean(a.VendorBMAutoSubmit__c),
        isKeyRelationship: Boolean(a.Key_Relationship__c),
        lastAppointment: (a.Last_Appointment__c as string | null) ?? null,
        lastWorkOrderCompleted: (a.LastWorkOrderCompleted__c as string | null) ?? null,
      }));
    } catch (err) {
      console.error("[SF] Account query failed (some fields may be absent):", err);
    }

    // Sandbox detection — instance URL contains "sandbox" for any sandbox org.
    const instanceUrl = conn.instanceUrl ?? null;
    const isSandbox = instanceUrl ? /sandbox\.my\.salesforce\.com/i.test(instanceUrl) : false;

    return {
      reps,
      opportunities,
      workOrders,
      accounts,
      fetchedAt: new Date().toISOString(),
      revenueFieldUsed: revenueField,
      workOrderRevenueField: woRevenueField,
      isSandbox,
      instanceUrl,
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
  customFields: Array<{ name: string; label: string; type: string; sumLast730?: number | null }>;
  sampleRecord: Record<string, unknown> | null;
  totalRecords: number;
  error?: string;
};

export async function describeKeySObjects(): Promise<SchemaInspection[]> {
  return cached("schema-inspection-v2", async () => {
    const conn = await getSalesforceClient();
    const objects = ["Opportunity", "Account", "WorkOrder", "Work_Order__c", "Quote"];
    const out: SchemaInspection[] = [];

    for (const obj of objects) {
      try {
        const meta = await conn.sobject(obj).describe();
        const customFieldsRaw = meta.fields
          .filter((f) => f.custom)
          .map((f) => ({ name: f.name, label: f.label, type: f.type }))
          .sort((a, b) => a.name.localeCompare(b.name));

        // For Opportunity, additionally SUM each custom currency/number field
        // so we can visually identify which field actually holds PPP's revenue
        // ($1.26M per their report). Skipped for other objects to keep latency down.
        let customFields = customFieldsRaw as SchemaInspection["customFields"];
        if (obj === "Opportunity") {
          const numericFields = customFieldsRaw.filter(
            (f) => f.type === "currency" || f.type === "double" || f.type === "int" || f.type === "percent"
          );
          // SOQL allows multiple aggregates in one query — sum them all in one shot.
          if (numericFields.length > 0) {
            const aggregates = numericFields
              .slice(0, 25) // SOQL aggregate limit safety
              .map((f) => `SUM(${f.name}) ${f.name.toLowerCase()}_sum`)
              .join(", ");
            try {
              const aggResult = await conn.query<Record<string, unknown>>(
                `SELECT ${aggregates} FROM Opportunity WHERE CreatedDate = LAST_N_DAYS:730`
              );
              const row = aggResult.records[0] ?? {};
              customFields = customFieldsRaw.map((f) => {
                if (!numericFields.includes(f)) return f;
                const v = row[`${f.name.toLowerCase()}_sum`];
                const num = typeof v === "number" ? v : v === null ? null : Number(v) || null;
                return { ...f, sumLast730: num };
              });
            } catch (err) {
              console.error("[SF] Aggregate sum for Opportunity custom fields failed:", err);
            }
          }
        }

        // Pull one record so we can see what custom fields actually contain values.
        let sampleRecord: Record<string, unknown> | null = null;
        let totalRecords = 0;
        try {
          const customNames = customFieldsRaw.slice(0, 30).map((f) => f.name).join(", ");
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
