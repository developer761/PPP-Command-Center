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

// 5 minutes — balanced against PPP's data freshness (manual refresh button
// in the topbar is always available for instant pulls). At PPP scale (20k+
// WOs in the 365d window) cold-cache loads are 8-15s; warm-cache is instant.
const CACHE_TTL_MS = 5 * 60 * 1000;

// IMPORTANT: cache the PROMISE, not just the resolved value. On a cold cache,
// when DashboardLayout + the page component both trigger loadDashboardData()
// in parallel (which happens on every page navigation), without Promise-level
// dedupe they BOTH end up fetching the full snapshot — doubling SF API load
// and wall time. Caching the Promise lets the second caller await the same
// in-flight request.
type CacheEntry<T> = { promise: Promise<T>; expiresAt: number };
const cache = new Map<string, CacheEntry<unknown>>();

async function cached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.promise as Promise<T>;
  const promise = fetcher();
  cache.set(key, { promise, expiresAt: now + CACHE_TTL_MS });
  // If the fetch rejects, invalidate the cache so the next request retries
  // instead of returning the same rejection for 5 minutes.
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  return promise;
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
  // Financial fields — present on most opps in production
  grossProfit: number;
  leadFee: number;
  discountGiven: number;
  customerPayments: number;
  customerBalance: number;
  // Geographic fields — for Map tab
  latitude: number | null;
  longitude: number | null;
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
  /** Where the lead came from (e.g., "Angi Ads", "Referral", "Google"). */
  leadGroup: string | null;
  /** Account Manager — the User assigned to handle this account post-sale. */
  accountManagerId: string | null;
  /** Free-text "Primary Contact" field on the Account. */
  primaryContact: string | null;
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
  // Operations + profitability fields
  grossProfit: number;
  commissionAmount: number;
  costMaterials: number;
  totalPayoutsForLabor: number;
  laborDaysActual: number | null;
  laborDaysProjected: number | null;
  laborDaysRemaining: number | null;
  balanceOwed: number;
  finalBalanceAging: number | null; // days
  // Geographic fields — populated on 20k+ WOs in production
  latitude: number | null;
  longitude: number | null;
};

/**
 * Quote object — feeds the real Pipeline Funnel.
 * PPP's flow: Lead → Quote → Opp → WO → Paid.
 */
export type SnapshotQuote = {
  id: string;
  opportunityId: string | null;
  subtotal: number;
  grandTotal: number;
  createdDate: string;
};

export type SalesforceSnapshot = {
  reps: SnapshotRep[];
  opportunities: SnapshotOpp[];
  workOrders: SnapshotWorkOrder[];
  accounts: SnapshotAccount[];
  quotes: SnapshotQuote[];
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

    // STEP 1: Discover Opportunity schema + pick the canonical revenue field.
    //
    // PPP's "Opportunities with Work Orders" report displays two headline totals:
    //   - "Total Net Value" = SUM(NetValue__c) — the realized revenue figure
    //   - "Total Quoted Subtotal with Change Order" = SUM(QuotedSubtotalWithChangeOrder__c) — gross quoted
    //
    // These field names were confirmed against the production org's 89,544
    // opportunities (2026-05-21 cutover deep-dive). We prefer them BY NAME so
    // the dashboard headline matches what PPP staff already read in their
    // reports — NOT the highest-sum field, which would surface TotalAmount__c
    // (a derived roll-up that's not the canonical "revenue" figure PPP uses).
    //
    // If neither named field exists (different org, schema drift), we fall
    // back to the highest-sum currency field for self-healing safety.
    const PREFERRED_OPP_REVENUE_FIELDS = [
      "NetValue__c",                      // PPP's canonical "Net Value"
      "QuotedSubtotalWithChangeOrder__c", // PPP's gross-quoted figure
      "Net_Value__c",                     // schema-variant fallback
      "Quoted_Subtotal_with_Change_Order__c",
    ];

    let revenueField: string | null = null;
    let allCurrencyFields: string[] = [];
    try {
      const meta = await conn.sobject("Opportunity").describe();
      allCurrencyFields = meta.fields
        .filter((f) => f.custom && (f.type === "currency" || f.type === "double"))
        .map((f) => f.name);

      // First: PPP canonical fields by name.
      for (const candidate of PREFERRED_OPP_REVENUE_FIELDS) {
        if (allCurrencyFields.includes(candidate)) {
          revenueField = candidate;
          console.log(`[SF] Opp revenue field (PPP canonical): ${revenueField}`);
          break;
        }
      }

      // Fallback: highest-sum (only if none of the preferred names exist).
      if (!revenueField && allCurrencyFields.length > 0) {
        const aggregates = allCurrencyFields
          .slice(0, 25)
          .map((n) => `SUM(${n}) ${n.toLowerCase()}_sum`)
          .join(", ");
        const sums = await conn.query<Record<string, number | null>>(
          `SELECT ${aggregates} FROM Opportunity`
        );
        const sumRow = sums.records[0] ?? {};
        let bestField: string | null = null;
        let bestSum = 0;
        for (const fname of allCurrencyFields) {
          const v = sumRow[`${fname.toLowerCase()}_sum`];
          if (typeof v === "number" && v > bestSum) {
            bestSum = v;
            bestField = fname;
          }
        }
        revenueField = bestField;
        console.log(`[SF] Opp revenue field (fallback by sum): ${revenueField} = $${bestSum.toLocaleString()}`);
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

    // At PPP scale (89k+ opps), pulling extra fields per row blows up payload
    // size + serverless memory. Narrow to ONLY fields the UI actually reads:
    //   - canonical revenue (NetValue / QuotedSubtotalWithChangeOrder)
    //   - Gross_Profit (Financials)
    //   - Lead_Fee / Discount_Given (Financials)
    // Dropped (dead in code as of audit): Customer_Payments, Customer_Balance,
    // Estimation_Address Lat/Long (empty in production anyway — Map uses WO geo).
    const NEEDED_OPP_FIELDS = new Set<string>([
      ...(revenueField ? [revenueField] : []),
      "NetValue__c",
      "QuotedSubtotalWithChangeOrder__c",
      "Gross_Profit__c",
      "Lead_Fee__c",
      "Discount_Given__c",
    ].filter((f) => allCurrencyFields.includes(f)));
    const currencyFieldsSelect = NEEDED_OPP_FIELDS.size > 0
      ? `, ${[...NEEDED_OPP_FIELDS].join(", ")}`
      : "";

    // SOQL returns at most 2000 records per batch. PPP has 89k+ opportunities
    // (10+ years of history), so we paginate via queryMore.
    //
    // Date window: at PPP scale (89k Opps, 88k WOs lifetime), pulling 730d
    // (40k+ WOs) made cold-cache loads slow. 365 days covers every reporting
    // window the dashboard surfaces (This Month / Last Month / This Year /
    // Last Year / Last 12 months) at ~20k WO volume — 2x faster than 730d
    // while keeping all common periods intact. "Last 24 months" view shows
    // partial data with a clear hint.
    const RECENCY_WINDOW_DAYS = 365;
    async function queryAllOpps(withCustomFields: boolean): Promise<SfOppRow[]> {
      const selectFields = `Id, OwnerId, Account.Name, Amount, IsClosed, IsWon, StageName, CreatedDate, CloseDate, LastActivityDate${withCustomFields ? currencyFieldsSelect : ""}`;
      const all: SfOppRow[] = [];
      let result = await conn.query<SfOppRow>(
        `SELECT ${selectFields} FROM Opportunity WHERE CreatedDate = LAST_N_DAYS:${RECENCY_WINDOW_DAYS}`
      );
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

    // PERF: kick off Account + Quote queries NOW so they run in parallel with
    // the upcoming WO schema discovery + WO query. Was sequential before
    // (Opp → WO → Account → Quote = ~25-30s). With these in parallel:
    // Opp finishes → start [Account, Quote, WO] in parallel → max(WO, ~10s)
    // saves ~5-10s on cold cache.
    const accountsPromise: Promise<SnapshotAccount[]> = (async () => {
      try {
        const ACCT_FIELDS = `
          Id, Name, Type, Service_Territory__c, Region__c, Geo_Zone__c, County__c,
          LeadGroup__c, Account_Manager__c, Primary_Contact__c,
          Total_Lifetime_Revenue__c, Total_Revenue_CFY__c, Total_Revenue_PFY__c,
          Total_Won_Oppties__c, Total_Lost_Oppties__c, Number_Open_Oppties__c,
          VendorBMRetailer__c, VendorBMAutoSubmit__c, Key_Relationship__c,
          Last_Appointment__c, LastWorkOrderCompleted__c
        `.replace(/\s+/g, " ").trim();
        const records: Array<Record<string, unknown>> = [];
        let result = await conn.query<Record<string, unknown>>(
          `SELECT ${ACCT_FIELDS} FROM Account ORDER BY Total_Lifetime_Revenue__c DESC NULLS LAST LIMIT 5000`
        );
        records.push(...result.records);
        while (!result.done && result.nextRecordsUrl) {
          result = await conn.queryMore<Record<string, unknown>>(result.nextRecordsUrl);
          records.push(...result.records);
        }
        console.log(`[SF] Pulled ${records.length} accounts (top 5k by lifetime revenue) — PARALLEL`);
        return records.map((a) => ({
          id: a.Id as string,
          name: (a.Name as string) ?? "",
          type: (a.Type as string | null) ?? null,
          serviceTerritoryId: (a.Service_Territory__c as string | null) ?? null,
          region: (a.Region__c as string | null) ?? null,
          geoZone: (a.Geo_Zone__c as string | null) ?? null,
          county: (a.County__c as string | null) ?? null,
          leadGroup: (a.LeadGroup__c as string | null) ?? null,
          accountManagerId: (a.Account_Manager__c as string | null) ?? null,
          primaryContact: (a.Primary_Contact__c as string | null) ?? null,
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
        return [];
      }
    })();

    const quotesPromise: Promise<SnapshotQuote[]> = (async () => {
      try {
        // Narrowed to fields actually used by the funnel derivation
        // (count + grandTotal sum). Subtotal__c and OpportunityId were
        // dead fields — dropped to shrink payload.
        const records: Array<Record<string, unknown>> = [];
        let result = await conn.query<Record<string, unknown>>(
          `SELECT Id, GrandTotal__c, CreatedDate FROM Quote WHERE CreatedDate = LAST_N_DAYS:${RECENCY_WINDOW_DAYS}`
        );
        records.push(...result.records);
        while (!result.done && result.nextRecordsUrl) {
          result = await conn.queryMore<Record<string, unknown>>(result.nextRecordsUrl);
          records.push(...result.records);
        }
        console.log(`[SF] Pulled ${records.length} quotes (last ${RECENCY_WINDOW_DAYS}d) — PARALLEL`);
        return records.map((q) => ({
          id: q.Id as string,
          opportunityId: null,
          subtotal: 0,
          grandTotal: typeof q.GrandTotal__c === "number" ? q.GrandTotal__c : 0,
          createdDate: q.CreatedDate as string,
        }));
      } catch (err) {
        console.error("[SF] Quote query failed:", err);
        return [];
      }
    })();

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
        grossProfit: typeof o.Gross_Profit__c === "number" ? o.Gross_Profit__c : 0,
        leadFee: typeof o.Lead_Fee__c === "number" ? o.Lead_Fee__c : 0,
        discountGiven: typeof o.Discount_Given__c === "number" ? o.Discount_Given__c : 0,
        customerPayments: 0,
        customerBalance: 0,
        latitude: null,
        longitude: null,
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

      // PPP canonical WO fields (production-verified 2026-05-21):
      //   NetValue__c — net realized revenue (what the "Net Value" report column sums)
      //   Quoted_Subtotal_with_Change_Order__c — gross quoted with change orders
      //   QuotedSubtotal__c — original quoted figure
      //   Subtotal__c — baseline subtotal
      const PREFERRED_WO_REVENUE_FIELDS = [
        "NetValue__c",
        "Quoted_Subtotal_with_Change_Order__c",
        "QuotedSubtotalWithChangeOrder__c",
        "QuotedSubtotal__c",
        "Subtotal__c",
      ];
      const byName = (re: RegExp) => woCurrencyFields.find((n) => re.test(n)) ?? null;
      woQuotedField = byName(/^Quoted_?Subtotal_?with_?Change_?Order/i)
        ?? byName(/^Quoted_?Subtotal/i);
      woNetField = byName(/^Net_?Value/i);

      // Canonical revenue field by name preference, fallback to highest-sum.
      for (const candidate of PREFERRED_WO_REVENUE_FIELDS) {
        if (woCurrencyFields.includes(candidate)) {
          woRevenueField = candidate;
          console.log(`[SF] WO revenue field (PPP canonical): ${woRevenueField}`);
          break;
        }
      }

      if (!woRevenueField && woCurrencyFields.length > 0) {
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
          console.log(`[SF] WO revenue field (fallback by sum): ${woRevenueField} = $${bestSum.toLocaleString()}`);
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

      // At PPP scale (88k+ WOs), narrow the SELECT to canonical revenue
      // + ops fields we actually surface (GP, commission, materials, labor,
      // payouts, AR aging).
      const opsFields = [
        "GrossProfit__c", "CommissionAmount__c", "CostMaterials__c",
        "TotalPayoutsForLabor__c", "LaborDaysActual__c", "LaborDaysProjected__c",
        "LaborDaysRemaining__c", "BalanceOwed__c", "Final_Balance_Aging__c",
      ].filter((f) => woCurrencyFields.includes(f) || woMeta.fields.some((mf) => mf.name === f));
      // Only pull the canonical revenue field + ops fields. Previously also
      // pulled woQuotedField + woNetField for display, but they're tacked
      // onto the Deal type via cast and never actually rendered anywhere.
      // Dropping saves a field per WO × 20k WOs.
      const NEEDED_WO_FIELDS = new Set<string>([
        ...(woRevenueField ? [woRevenueField] : []),
        ...opsFields,
      ]);
      const woFieldList = [
        "Id",
        woNumberField,
        woStatusField,
        "CreatedDate",
        // Standard SF geocoding fields — 20k+ WOs have these populated
        "Latitude",
        "Longitude",
        ...NEEDED_WO_FIELDS,
        woOppLookup,
        woOppRelName ? `${woOppRelName}.OwnerId` : null,
        woOppRelName ? `${woOppRelName}.Owner.Name` : null,
        woOppRelName ? `${woOppRelName}.Account.Name` : null,
        woOppRelName ? `${woOppRelName}.CloseDate` : null,
      ].filter((x): x is string => Boolean(x));

      // Same 2-year window as opps (88,500 WOs lifetime → Vercel timeout risk).
      let result = await conn.query<Record<string, unknown>>(
        `SELECT ${woFieldList.join(", ")} FROM WorkOrder WHERE CreatedDate = LAST_N_DAYS:${RECENCY_WINDOW_DAYS}`
      );
      workOrderRecords.push(...result.records);
      while (!result.done && result.nextRecordsUrl) {
        result = await conn.queryMore<Record<string, unknown>>(result.nextRecordsUrl);
        workOrderRecords.push(...result.records);
      }
      console.log(`[SF] Pulled ${workOrderRecords.length} work orders (last ${RECENCY_WINDOW_DAYS}d)`);
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
      // quotedSubtotal + netValue are unsurfaced in the UI — set to 0 so the
      // SnapshotWorkOrder shape stays stable. If a future view needs them
      // (e.g., comparing quoted vs realized per deal), re-add the fields to
      // the SOQL above and read them here.
      const quoted = 0;
      const net = 0;

      const opp = woOppRelName ? (w[woOppRelName] as Record<string, unknown> | undefined) : undefined;
      const ownerNested = opp?.Owner as Record<string, unknown> | undefined;
      const accountNested = opp?.Account as Record<string, unknown> | undefined;

      const num = (k: string): number => typeof w[k] === "number" ? (w[k] as number) : 0;
      const numOrNull = (k: string): number | null => typeof w[k] === "number" ? (w[k] as number) : null;

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
        grossProfit: num("GrossProfit__c"),
        commissionAmount: num("CommissionAmount__c"),
        costMaterials: num("CostMaterials__c"),
        totalPayoutsForLabor: num("TotalPayoutsForLabor__c"),
        laborDaysActual: numOrNull("LaborDaysActual__c"),
        laborDaysProjected: numOrNull("LaborDaysProjected__c"),
        laborDaysRemaining: numOrNull("LaborDaysRemaining__c"),
        balanceOwed: num("BalanceOwed__c"),
        finalBalanceAging: numOrNull("Final_Balance_Aging__c"),
        latitude: numOrNull("Latitude"),
        longitude: numOrNull("Longitude"),
      };
    });

    // Await the Account + Quote promises that have been running in parallel
    // with the WO query above. Both already executed concurrently — this is
    // just collecting their results.
    const [accounts, quotes] = await Promise.all([accountsPromise, quotesPromise]);

    // Sandbox detection — instance URL contains "sandbox" for any sandbox org.
    const instanceUrl = conn.instanceUrl ?? null;
    const isSandbox = instanceUrl ? /sandbox\.my\.salesforce\.com/i.test(instanceUrl) : false;

    return {
      reps,
      opportunities,
      workOrders,
      accounts,
      quotes,
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
