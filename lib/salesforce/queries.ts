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
  /** True when Profile.Name ends with "Standard.Field" — PPP's canonical
   *  field-rep universe (per BUSINESS_RULES.md). Manager-level + admin users
   *  are excluded. Used by deriveRepScorecard + team-average denominators. */
  isFieldStandard: boolean;
  /** Per-rep gross-margin target (e.g. 0.45 = 45%). PPP sets this on the User
   *  record. null when not configured for this user. */
  gmGoalPercent: number | null;
  /** Quarterly draw — base commission cap per fiscal quarter. null when
   *  not configured (most reps don't have this populated). */
  quarterlyDraw: number | null;
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
  /** PPP's canonical SALES metric (KPI 1). Different field name vs the WO
   *  equivalent — Opp uses no underscores, WO uses them. Populated on every
   *  Opp; falls back to 0 only when SF returned null. */
  quotedSubtotal: number;
  /** Lead source bucketing (KPI 3): "Self-Generated" → self-gen, everything
   *  else (incl. null) → marketing. NOTE: distinct from Account.LeadGroup__c;
   *  PPP classifies on the Opp field for close-rate purposes. */
  leadGroup: string | null;
  /** Appointment scheduled on this Opp (KPI 5). ISO date or null. */
  appointmentDate: string | null;
  /** True when an appointment was scheduled but cancelled. */
  cancelledAppointment: boolean;
  /** True when an estimate has been sent on this Opp (KPI 5 / KPI 6). */
  estimateSent: boolean;
  /** Date the estimate was sent — drives stale-pipeline detection (KPI 6).
   *  Stale = open + estimate_sent + dateEstimateSent < today − 30. */
  dateEstimateSent: string | null;
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
  /** WorkType.Name from the standard FSL relationship — used to filter out
   *  pre-quote stages (Estimate / Appointment) on the Materials Ordering page. */
  workTypeName: string | null;
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
  /** PPP canonical GM% formula field — `Gross_Profit__c / Quoted_Subtotal_with_Change_Order__c`.
   *  Decimal (e.g. 0.42 = 42%). DO NOT confuse with GrossProfitPercent__c
   *  (which uses NetValue__c denominator and inflates margins). KPI 2. */
  grossMarginPercent: number | null;
  /** PPP's canonical Materials % numerator — distinct from `costMaterials`
   *  (CostMaterials__c). Used for KPI 4 (Pricing Discipline). */
  totalNonBillablePurchases: number;
  /** Job completion anchor for KPI 7 (Jobs completed vs sold) + KPI 2 GM.
   *  Often null on open/in-progress WOs. */
  endDate: string | null;
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

/**
 * Work Order Line Item — the standard SF FSL object (WorkOrderLineItem), NOT
 * the custom Work_Order_Line_Item__c the architecture PDF mentioned. Schema
 * verified on production 2026-05-22 (163k records). Drives Phase 2 Materials
 * Ordering — every WO breaks down into multiple WOLI rows, one per room/area,
 * each with up to 5 paint color references (wall / ceiling / trim / floor / other).
 */
export type SnapshotWoli = {
  id: string;
  workOrderId: string;
  areaLabel: string | null; // "Master Bedroom" / "Living Room" / etc.
  surfaces: string | null; // multipicklist as ";"-joined string ("Walls;Ceiling;Trim")
  sqFootage: number;
  wallSurfaceArea: number;
  perimeter: number;
  numCoats: number;
  primer: string | null;
  prepLevel: string | null;
  productFamily: string | null; // "Interior Painting" / "Exterior Painting"
  interiorExterior: string | null;
  numClosets: number;
  numDoors: number;
  numWindows: number;
  productName: string | null;
  totalPrice: number;
  // Color slots — each holds a PaintColor__c Id (string) or null when no color
  // is assigned to that surface on this line item.
  colorWallId: string | null;
  colorCeilingId: string | null;
  colorTrimId: string | null;
  colorOtherId: string | null;
  colorFloorId: string | null;
  finishWall: string | null;
  finishCeiling: string | null;
  finishTrim: string | null;
  finishOther: string | null;
  finishFloor: string | null;
  colorNotes: string | null;
  sortOrder: number;
  changeOrderRelated: boolean;
};

/**
 * Paint Color — `PaintColor__c` (one word + __c). Verified shape from prod
 * 2026-05-22 (5,762 records). Critical Phase 2 input: `manufacturerId` is an
 * Account reference (PPP models paint suppliers as Accounts, flagged via
 * `Account.VendorBMRetailer__c`), so "group orders by supplier" is a join.
 */
export type SnapshotPaintColor = {
  id: string;
  /** Standard SF Name — usually equals FullName__c, e.g. "2108-40 Stardust". */
  name: string;
  /** Color name only, e.g. "Stardust". */
  shortName: string | null;
  /** Color code / SKU, e.g. "2108-40" (BM) or "SW6462" (SW). */
  code: string | null;
  /** Collection grouping, e.g. "Color Preview", "Historical Colors". */
  collection: string | null;
  /** Hex value (often empty in PPP's data but the field exists). */
  hexValue: string | null;
  /** Manufacturer is an Account.Id reference — the paint supplier. */
  manufacturerId: string | null;
};

/**
 * Annual rep quota row — `TotalQuota__c`. We pull current + prior fiscal year
 * with the strict filter (`QuotaType__c='Field_Member'`, `Allocation__c='Owner'`,
 * `Status__c='Active'`), excluding `CatchAll`. Most reps don't have a row yet,
 * so KPIs render a graceful "no quota set" state instead of $0 / Infinity.
 *
 * ⚠️ Trap: `SubQuota__c.CurrentUserId__c` is the *viewer's* id, NOT the rep.
 * Always join via `TotalQuota__r.User__c` (modeled here as `userId`).
 */
export type SnapshotQuota = {
  id: string;
  userId: string;
  fy: number; // FY name (start year) e.g. 2026
  quotaAssigned: number; // QuotaAssigned__c (dollars, 1:1 with points)
  status: string | null;
  allocation: string | null; // "Owner" / "CatchAll" — we filter to Owner
  quotaType: string | null;  // "Field_Member" — we filter to that
};

/** Monthly quota row — sub-rows under TotalQuota__c. */
export type SnapshotSubQuota = {
  id: string;
  totalQuotaId: string;
  userId: string; // resolved via parent TotalQuota__r.User__c (NOT CurrentUserId__c)
  fy: number;
  fiscalMonth: number; // 1..12 calendar month
  assigned: number;    // Assigned__c (goal $)
  attained: number;    // Attained__c (rolling Closed-Won sum)
};

/**
 * Money flow — `Transaction__c`. RECORD-TYPE-driven:
 *   - Payment_In   → revenue collected
 *   - Payment_Out  → payments out (PayeeType__c='Labor_Company' = labor paid)
 *   - Purchase     → materials/other purchases
 *
 * Attribute by `WorkOrder__r.OwnerId` (resolved via workOrderOwnerId here).
 * Commissions: where Payment_Out with WorkOrder__c set + Payee__r.Name matches
 * a rep's name (watch for `<Name>-inactive`/`-portal` shadow Users).
 *
 * Label convention (per BUSINESS_RULES.md): in any UI, expand to
 * "Payments / Payouts / Purchases" — never abbreviate "transaction" to "tx".
 */
export type SnapshotTransaction = {
  id: string;
  recordType: string | null;  // "Payment_In" / "Payment_Out" / "Purchase"
  amount: number;
  date: string;               // Date__c (ISO date)
  payeeType: string | null;   // "Labor_Company" / "Reimbursement" / etc.
  payeeName: string | null;   // resolved via Payee__r.Name
  workOrderId: string | null;
  workOrderOwnerId: string | null; // resolved via WorkOrder__r.OwnerId
  opportunityId: string | null;
};

/**
 * Review — `Review__c`. KPI 7 (Production Quality).
 * Attribute via `Account__r.OwnerId` (NOT Opp/WO owner). Exclude `Removed__c`.
 */
export type SnapshotReview = {
  id: string;
  isGood: boolean;       // GoodReview__c (ratings 4-5)
  isBad: boolean;        // BadReview__c (ratings 1-3)
  isRemoved: boolean;    // Excluded from counts when true
  accountId: string | null;
  accountOwnerId: string | null;
  createdDate: string;
};

/**
 * Customer-complaint Case. KPI 7 (Complaints).
 * Customer-facing types only:
 *   "Estimator No Show", "Waiting for Estimate", "Dissatisfied Customer",
 *   "Balance Owed", "Service Call", "Other".
 *
 * Attribute via `Case.Opportunity__r.OwnerId` (covers both no-show and
 * service-call cases).
 */
export type SnapshotCase = {
  id: string;
  caseNumber: string | null;
  type: string | null;
  status: string | null;
  createdDate: string;
  opportunityId: string | null;
  opportunityOwnerId: string | null; // resolved via Opportunity__r.OwnerId
};

export type SalesforceSnapshot = {
  reps: SnapshotRep[];
  opportunities: SnapshotOpp[];
  workOrders: SnapshotWorkOrder[];
  accounts: SnapshotAccount[];
  quotes: SnapshotQuote[];
  /** Phase 2: line items + paint color directory. */
  woLineItems: SnapshotWoli[];
  paintColors: SnapshotPaintColor[];
  /** Rep performance: annual + monthly quotas, money flow, reviews, cases. */
  quotas: SnapshotQuota[];
  subQuotas: SnapshotSubQuota[];
  transactions: SnapshotTransaction[];
  reviews: SnapshotReview[];
  cases: SnapshotCase[];
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
  // Custom rep-performance fields — read-conditional. SF will silently omit
  // these if FLS isn't granted to the OAuth user. Falls through to null.
  Gross_Margin_Goal_Percent__c?: number | null;
  Quarterly_Draw__c?: number | null;
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
  // Cache key bumped to v4 — adds rep-performance pulls (quotas, transactions,
  // reviews, cases) + new opp/WO/User fields per Katie's REP_PROFILES guide.
  return cached("snapshot-v4", async () => {
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
    // ORDER MATTERS. Per PPP's KPI 1 spec (REP_PERFORMANCE_KPIS.md), the
    // canonical SALES metric is QuotedSubtotalWithChangeOrder__c — that's what
    // % to Goal, the FY Sales report, and quota attainment all anchor on.
    // NetValue__c is "realized/collected" (a different metric, used for AR
    // visibility). For the snapshot's headline `revenueField` we now prefer
    // the quoted figure. The mapper below ALSO captures NetValue separately
    // in `opp.quotedSubtotal` was already named confusingly — we now keep
    // `amount` populated by the canonical (quoted) field, and read NetValue
    // through a separate path for realized-revenue surfaces.
    const PREFERRED_OPP_REVENUE_FIELDS = [
      "QuotedSubtotalWithChangeOrder__c", // PPP canonical sales metric
      "NetValue__c",                      // realized/collected fallback
      "Quoted_Subtotal_with_Change_Order__c", // schema-variant fallback
      "Net_Value__c",
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
    // User query — additive pull of the two PPP rep-performance fields
    // (Gross_Margin_Goal_Percent__c, Quarterly_Draw__c). These are
    // FLS-restricted in PPP's prod; if the OAuth user can't read them, the
    // query fails. We try the rich SELECT first, fall back to baseline on
    // ANY error so a missing field doesn't break the whole snapshot.
    const usersPromise: Promise<{ records: SfUserRow[] }> = (async () => {
      const baseFields = "Id, Name, FirstName, LastName, Email, IsActive, CreatedDate, UserType, Profile.Name, UserRole.Name, Department";
      const richFields = `${baseFields}, Gross_Margin_Goal_Percent__c, Quarterly_Draw__c`;
      try {
        return await conn.query<SfUserRow>(`
          SELECT ${richFields}
          FROM User
          WHERE IsActive = true
          LIMIT 500
        `);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Common: INVALID_FIELD / INSUFFICIENT_ACCESS on the new fields. Both
        // are non-fatal — we just don't get GM target / draw for KPI 2/9.
        console.warn(`[SF] User rich-fields query failed (falling back to base): ${msg}`);
        return await conn.query<SfUserRow>(`
          SELECT ${baseFields}
          FROM User
          WHERE IsActive = true
          LIMIT 500
        `);
      }
    })();

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

    // Non-currency rep-performance fields (KPI 3/5/6). Read-conditional via
    // describe() so we don't blow up the query when a field is missing/FLS-hidden.
    let allOppFieldNames = new Set<string>();
    try {
      const oppMeta2 = await conn.sobject("Opportunity").describe();
      allOppFieldNames = new Set(oppMeta2.fields.map((f) => f.name));
    } catch {
      // Already logged above in schema discovery — describe failures shouldn't
      // block the pull. We'll get null for fields we can't confirm exist.
    }
    const REP_PERF_OPP_FIELDS = [
      "LeadGroup__c",
      "AppointmentDate__c",
      "Cancelled_Appointment__c",
      "Estimate_Sent__c",
      "Date_Estimate_Sent__c",
    ].filter((f) => allOppFieldNames.has(f));
    const repPerfOppFieldsSelect = REP_PERF_OPP_FIELDS.length > 0
      ? `, ${REP_PERF_OPP_FIELDS.join(", ")}`
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
      const selectFields = `Id, OwnerId, Account.Name, Amount, IsClosed, IsWon, StageName, CreatedDate, CloseDate, LastActivityDate${withCustomFields ? currencyFieldsSelect + repPerfOppFieldsSelect : ""}`;
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
        // Two queries unioned:
        //   1. Top 5,000 accounts by lifetime revenue (PPP's customers)
        //   2. ALL vendor accounts (paint suppliers — Benjamin Moore, Sherwin
        //      Williams, etc.). They sell TO PPP so have $0 lifetime revenue
        //      and get dropped by the revenue ORDER BY. Without them in the
        //      snapshot, PaintColor.Manufacturer__c can't resolve to a
        //      supplier name and the Materials Ordering UI shows "Unknown
        //      supplier" everywhere. Vendor count is ~1,355 (per prod
        //      describe), totally fits in a single page.
        let result = await conn.query<Record<string, unknown>>(
          `SELECT ${ACCT_FIELDS} FROM Account ORDER BY Total_Lifetime_Revenue__c DESC NULLS LAST LIMIT 5000`
        );
        records.push(...result.records);
        while (!result.done && result.nextRecordsUrl) {
          result = await conn.queryMore<Record<string, unknown>>(result.nextRecordsUrl);
          records.push(...result.records);
        }
        console.log(`[SF] Pulled ${records.length} accounts (top 5k by lifetime revenue) — PARALLEL`);

        // Vendor pull — union into the same array, deduped by Id.
        try {
          const seenIds = new Set(records.map((r) => r.Id as string));
          let vendorResult = await conn.query<Record<string, unknown>>(
            `SELECT ${ACCT_FIELDS} FROM Account WHERE Type IN ('Retail Vendor','Service Vendor','Marketing Vendor') LIMIT 2000`
          );
          let added = 0;
          for (const r of vendorResult.records) {
            const id = r.Id as string;
            if (!seenIds.has(id)) {
              seenIds.add(id);
              records.push(r);
              added++;
            }
          }
          while (!vendorResult.done && vendorResult.nextRecordsUrl) {
            vendorResult = await conn.queryMore<Record<string, unknown>>(vendorResult.nextRecordsUrl);
            for (const r of vendorResult.records) {
              const id = r.Id as string;
              if (!seenIds.has(id)) {
                seenIds.add(id);
                records.push(r);
                added++;
              }
            }
          }
          console.log(`[SF] Pulled ${added} additional vendor accounts (paint suppliers) — PARALLEL`);
        } catch (vendorErr) {
          console.error("[SF] Vendor account pull failed (non-fatal):", vendorErr);
        }

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
        // Funnel derivation needs count + grandTotal + opportunityId (the link
        // back to the parent opp so scopeSnapshotToViewer can filter quotes
        // when viewer.scope === "my"). Subtotal__c is dead — left off.
        const records: Array<Record<string, unknown>> = [];
        let result = await conn.query<Record<string, unknown>>(
          `SELECT Id, OpportunityId, GrandTotal__c, CreatedDate FROM Quote WHERE CreatedDate = LAST_N_DAYS:${RECENCY_WINDOW_DAYS}`
        );
        records.push(...result.records);
        while (!result.done && result.nextRecordsUrl) {
          result = await conn.queryMore<Record<string, unknown>>(result.nextRecordsUrl);
          records.push(...result.records);
        }
        console.log(`[SF] Pulled ${records.length} quotes (last ${RECENCY_WINDOW_DAYS}d) — PARALLEL`);
        return records.map((q) => ({
          id: q.Id as string,
          opportunityId: typeof q.OpportunityId === "string" ? q.OpportunityId : null,
          subtotal: 0,
          grandTotal: typeof q.GrandTotal__c === "number" ? q.GrandTotal__c : 0,
          createdDate: q.CreatedDate as string,
        }));
      } catch (err) {
        console.error("[SF] Quote query failed:", err);
        return [];
      }
    })();

    // Phase 2 — WorkOrderLineItem (standard SF FSL object). 163k records on
    // prod 2026-05-22.
    //
    // KNOWN ORG BEHAVIOR (verified via /api/admin/wo-debug 2026-05-22):
    //   - Direct WHERE CreatedDate = LAST_N_DAYS:N → MALFORMED_QUERY
    //   - Direct ORDER BY CreatedDate DESC → MALFORMED_QUERY
    //   - Parent-relationship subqueries via WorkOrderLineItems → MALFORMED_QUERY
    //   - BUT: `WHERE WorkOrderId IN ('id1','id2',...)` → WORKS
    //
    // STRATEGY: this fetcher waits for the WO query to finish, then queries
    // WOLI explicitly by the WO Ids we already pulled — batched in chunks of
    // 200 because SOQL's IN-clause character budget caps around 100kB.
    // Guaranteed correctness: every WOLI we get back belongs to a WO in our
    // snapshot. No more "30k arbitrary, 0 matched."
    //
    // Note: this changes the dependency graph — woLineItemsPromise can't
    // start until workOrders is materialized. We accept that tradeoff because
    // (a) WOLI is small relative to the WO pull, and (b) correctness >>
    // parallelism here.
    const WOLI_BATCH_SIZE = 200;
    const wrapWoliFetch = async (woIds: string[]): Promise<SnapshotWoli[]> => {
      const t0 = Date.now();
      if (woIds.length === 0) {
        console.log("[SF] WOLI fetch skipped — no WOs to scope to");
        return [];
      }
      try {
        const fields = [
          "Id", "WorkOrderId",
          "AreaLabel__c", "Surfaces__c", "Sq_Footage__c", "Wall_Surface_Area__c",
          "of_Coats__c", "Product_Family__c",
          "ColorWall__c", "ColorCeiling__c", "ColorTrim__c", "ColorOther__c", "ColorFloor__c",
        ];
        const records: Array<Record<string, unknown>> = [];
        const batchCount = Math.ceil(woIds.length / WOLI_BATCH_SIZE);
        console.log(`[SF] WOLI fetch starting — ${woIds.length} WO ids in ${batchCount} batch(es) of ${WOLI_BATCH_SIZE}`);
        for (let i = 0; i < woIds.length; i += WOLI_BATCH_SIZE) {
          const batch = woIds.slice(i, i + WOLI_BATCH_SIZE);
          const inClause = batch.map((id) => `'${id}'`).join(",");
          let result = await conn.query<Record<string, unknown>>(
            `SELECT ${fields.join(", ")} FROM WorkOrderLineItem WHERE WorkOrderId IN (${inClause})`
          );
          records.push(...result.records);
          while (!result.done && result.nextRecordsUrl) {
            result = await conn.queryMore<Record<string, unknown>>(result.nextRecordsUrl);
            records.push(...result.records);
          }
          const batchNum = Math.floor(i / WOLI_BATCH_SIZE) + 1;
          if (batchNum % 5 === 0 || batchNum === batchCount) {
            console.log(`[SF] WOLI batch ${batchNum}/${batchCount}: total ${records.length} rows (${Date.now() - t0}ms)`);
          }
        }
        console.log(`[SF] WOLI DONE — ${records.length} rows in ${Date.now() - t0}ms`);
        const num = (r: Record<string, unknown>, k: string): number =>
          typeof r[k] === "number" ? (r[k] as number) : 0;
        const str = (r: Record<string, unknown>, k: string): string | null =>
          typeof r[k] === "string" ? (r[k] as string) : null;
        return records.map<SnapshotWoli>((r) => ({
          id: r.Id as string,
          workOrderId: r.WorkOrderId as string,
          areaLabel: str(r, "AreaLabel__c"),
          surfaces: str(r, "Surfaces__c"),
          sqFootage: num(r, "Sq_Footage__c"),
          wallSurfaceArea: num(r, "Wall_Surface_Area__c"),
          perimeter: 0,
          numCoats: num(r, "of_Coats__c"),
          primer: null,
          prepLevel: null,
          productFamily: str(r, "Product_Family__c"),
          interiorExterior: null,
          numClosets: 0,
          numDoors: 0,
          numWindows: 0,
          productName: null,
          totalPrice: 0,
          colorWallId: str(r, "ColorWall__c"),
          colorCeilingId: str(r, "ColorCeiling__c"),
          colorTrimId: str(r, "ColorTrim__c"),
          colorOtherId: str(r, "ColorOther__c"),
          colorFloorId: str(r, "ColorFloor__c"),
          // Finish fields dropped from initial pull to fit Vercel timeout.
          // Re-add to SELECT + map here once base query is reliably working.
          finishWall: null,
          finishCeiling: null,
          finishTrim: null,
          finishOther: null,
          finishFloor: null,
          colorNotes: null,
          sortOrder: 0,
          changeOrderRelated: false,
        }));
      } catch (err) {
        // Don't silently return [] — log the full error shape so we can see
        // exactly what SF rejected. Still returns [] so the rest of the page
        // renders, but the next deploy's logs will tell us why.
        const ms = Date.now() - t0;
        const message = err instanceof Error ? err.message : String(err);
        const name = err instanceof Error ? err.name : "unknown";
        console.error(`[SF] WOLI FAILED after ${ms}ms — ${name}: ${message}`);
        if (err && typeof err === "object" && "errorCode" in err) {
          console.error(`[SF] WOLI SOQL errorCode: ${(err as { errorCode?: string }).errorCode}`);
        }
        return [];
      }
    };

    // PaintColor__c — 5,762 total records, no time window (color directory).
    const paintColorsPromise: Promise<SnapshotPaintColor[]> = (async () => {
      try {
        const records: Array<Record<string, unknown>> = [];
        let result = await conn.query<Record<string, unknown>>(
          `SELECT Id, Name, Name__c, Code__c, Collection__c, HexValue__c, Manufacturer__c FROM PaintColor__c`
        );
        records.push(...result.records);
        while (!result.done && result.nextRecordsUrl) {
          result = await conn.queryMore<Record<string, unknown>>(result.nextRecordsUrl);
          records.push(...result.records);
        }
        console.log(`[SF] Pulled ${records.length} paint colors — PARALLEL`);
        const str = (r: Record<string, unknown>, k: string): string | null =>
          typeof r[k] === "string" ? (r[k] as string) : null;
        return records.map<SnapshotPaintColor>((r) => ({
          id: r.Id as string,
          name: (r.Name as string) ?? "",
          shortName: str(r, "Name__c"),
          code: str(r, "Code__c"),
          collection: str(r, "Collection__c"),
          hexValue: str(r, "HexValue__c"),
          manufacturerId: str(r, "Manufacturer__c"),
        }));
      } catch (err) {
        console.error("[SF] PaintColor__c query failed:", err);
        return [];
      }
    })();

    const usersResult = await usersPromise;

    const reps: SnapshotRep[] = usersResult.records
      .filter((u) => u.UserType === "Standard" || u.UserType === "PowerPartner" || u.UserType === null)
      .filter((u) => isLikelyRep(u.Profile?.Name ?? null, u.IsActive))
      .map((u) => {
        // PPP's canonical rep universe = Profile.Name ending in "Standard.Field"
        // (~26 active reps per the BUSINESS_RULES doc). Non-field-standard
        // users (admins / managers / office) are still pulled so we can name
        // them in WO/Opp owner lookups, but they're excluded from KPIs +
        // team-average denominators via isFieldStandard.
        const profile = u.Profile?.Name ?? "";
        const isFieldStandard = /Standard\.Field\s*$/i.test(profile);
        return {
          id: u.Id,
          name: u.Name,
          firstName: u.FirstName,
          lastName: u.LastName,
          email: u.Email,
          profileName: u.Profile?.Name ?? null,
          roleName: u.UserRole?.Name ?? null,
          department: u.Department,
          createdDate: u.CreatedDate,
          isFieldStandard,
          gmGoalPercent: typeof u.Gross_Margin_Goal_Percent__c === "number"
            ? (u.Gross_Margin_Goal_Percent__c as number)
            : null,
          quarterlyDraw: typeof u.Quarterly_Draw__c === "number"
            ? (u.Quarterly_Draw__c as number)
            : null,
        };
      });

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

      // Canonical SALES metric (KPI 1). Distinct from `amount` (which may
      // be NetValue/realized in legacy code paths). Falls back to amount when
      // the canonical field is null/absent so downstream callers always get
      // *something* for the sales attribution.
      const canonicalQuoted = typeof o.QuotedSubtotalWithChangeOrder__c === "number"
        ? (o.QuotedSubtotalWithChangeOrder__c as number)
        : 0;

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
        // Rep performance fields (KPI 1/3/5/6) — silently null when SF
        // didn't return them (FLS / field missing on this Opp record type).
        quotedSubtotal: canonicalQuoted > 0 ? canonicalQuoted : resolved,
        leadGroup: typeof o.LeadGroup__c === "string" ? (o.LeadGroup__c as string) : null,
        appointmentDate: typeof o.AppointmentDate__c === "string" ? (o.AppointmentDate__c as string) : null,
        cancelledAppointment: Boolean(o.Cancelled_Appointment__c),
        estimateSent: Boolean(o.Estimate_Sent__c),
        dateEstimateSent: typeof o.Date_Estimate_Sent__c === "string" ? (o.Date_Estimate_Sent__c as string) : null,
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
      // ORDER MATTERS — see Opp PREFERRED_OPP_REVENUE_FIELDS for rationale.
      // PPP canonical SALES anchor is Quoted_Subtotal_with_Change_Order__c (KPI 1).
      // NetValue__c is realized/collected — kept as fallback for AR surfaces.
      const PREFERRED_WO_REVENUE_FIELDS = [
        "Quoted_Subtotal_with_Change_Order__c",
        "QuotedSubtotalWithChangeOrder__c",
        "NetValue__c",
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
      // payouts, AR aging) + rep-performance KPI fields (canonical GM%,
      // materials %, completion anchor).
      const opsFields = [
        "GrossProfit__c", "CommissionAmount__c", "CostMaterials__c",
        "TotalPayoutsForLabor__c", "LaborDaysActual__c", "LaborDaysProjected__c",
        "LaborDaysRemaining__c", "BalanceOwed__c", "Final_Balance_Aging__c",
        // Rep performance fields — Gross_Margin_Percent__c is PPP's canonical
        // GM%; TotalNonBillablePurchases__c feeds KPI 4 Materials %; EndDate
        // is the period anchor for KPI 2 + KPI 7. EndDate is standard SF (not
        // custom), included via the meta check below.
        "Gross_Margin_Percent__c",
        "TotalNonBillablePurchases__c",
      ].filter((f) => woCurrencyFields.includes(f) || woMeta.fields.some((mf) => mf.name === f));
      // EndDate is standard date field — include if present.
      const hasEndDate = woMeta.fields.some((f) => f.name === "EndDate");
      // Pull canonical revenue + ops fields PLUS the quoted-subtotal field
      // (Quoted_Subtotal_with_Change_Order__c). Reason: PPP only populates
      // NetValue__c on billed/realized WOs. A WO in "Quoted" / "Coordination"
      // status has NetValue=null but Quoted_Subtotal populated. Without the
      // quoted field as a fallback, Recent Deals on the rep profile shows
      // $0 for every open deal (fixed 2026-05-21).
      const NEEDED_WO_FIELDS = new Set<string>([
        ...(woRevenueField ? [woRevenueField] : []),
        ...(woQuotedField ? [woQuotedField] : []),
        ...opsFields,
      ]);
      const woFieldList = [
        "Id",
        woNumberField,
        woStatusField,
        "CreatedDate",
        hasEndDate ? "EndDate" : null,
        // Standard SF geocoding fields — 20k+ WOs have these populated
        "Latitude",
        "Longitude",
        // Standard FSL WorkType relationship — Materials Ordering uses this to
        // filter out pre-quote stages (Estimate / Appointment) where there's
        // nothing to order yet.
        "WorkType.Name",
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
      // Per-WO amount resolution:
      //   1. Try canonical revenue field (NetValue__c) — populated when WO is billed
      //   2. If 0/null, fall back to Quoted_Subtotal_with_Change_Order__c — the
      //      figure on open/quoted deals before billing closes them out
      //   3. Last resort: max across all currency fields (defensive)
      // Without #2, every "Quoted" / "Coordination" WO shows $0 in Recent Deals.
      let resolved = 0;
      if (woRevenueField) {
        const v = w[woRevenueField];
        if (typeof v === "number" && v > 0) resolved = v;
      }
      const quoted =
        woQuotedField && typeof w[woQuotedField] === "number"
          ? (w[woQuotedField] as number)
          : 0;
      if (resolved === 0 && quoted > 0) {
        resolved = quoted;
      }
      if (resolved === 0) {
        for (const fname of woCurrencyFields) {
          const v = w[fname];
          if (typeof v === "number" && v > resolved) resolved = v;
        }
      }
      const net = woRevenueField && typeof w[woRevenueField] === "number"
        ? (w[woRevenueField] as number)
        : 0;

      const opp = woOppRelName ? (w[woOppRelName] as Record<string, unknown> | undefined) : undefined;
      const ownerNested = opp?.Owner as Record<string, unknown> | undefined;
      const accountNested = opp?.Account as Record<string, unknown> | undefined;
      // WorkType is a standard FSL relationship on WorkOrder. The relationship
      // name is `WorkType` (singular). The nested Name carries values like
      // "Estimate", "Appointment", "Paint Job" — Materials Ordering uses this
      // to skip the pre-quote stages where no materials are needed yet.
      const workTypeNested = w.WorkType as Record<string, unknown> | undefined;

      const num = (k: string): number => typeof w[k] === "number" ? (w[k] as number) : 0;
      const numOrNull = (k: string): number | null => typeof w[k] === "number" ? (w[k] as number) : null;

      return {
        id: w.Id as string,
        workOrderNumber: woNumberField ? (w[woNumberField] as string | null) ?? null : null,
        status: woStatusField ? (w[woStatusField] as string | null) ?? null : null,
        workTypeName: workTypeNested ? (workTypeNested.Name as string | null) ?? null : null,
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
        // Rep performance fields. Gross_Margin_Percent__c is a percent-formula
        // field; SF returns it as the percent value (e.g. 42.5 for 42.5%) not
        // the decimal — keep that representation through the snapshot.
        grossMarginPercent: numOrNull("Gross_Margin_Percent__c"),
        totalNonBillablePurchases: num("TotalNonBillablePurchases__c"),
        endDate: typeof w.EndDate === "string" ? (w.EndDate as string) : null,
      };
    });

    // ─────────────────────────────────────────────────────────────────
    // Rep-performance pulls (Katie's REP_PROFILES_INTEGRATION_GUIDE §6.8)
    //
    // Each is wrapped in try/catch returning [] on failure so a missing
    // object / FLS gap on the OAuth user doesn't blow up the whole snapshot.
    // All are windowed/filtered to current + prior FY where applicable.
    //
    // Per BUSINESS_RULES.md the canonical SubQuota rep linkage is
    // TotalQuota__r.User__c (NOT SubQuota.CurrentUserId__c — that returns
    // the *viewer's* user id, a formula trap).
    // ─────────────────────────────────────────────────────────────────
    const CFY_START_ISO = (() => {
      // PPP fiscal year starts Feb 1. KPI 1 uses CFY anchor; we pull current
      // + prior so the UI can show period selectors without re-querying.
      const now = new Date();
      const m = now.getUTCMonth();
      const y = now.getUTCFullYear();
      const fyStart = m === 0 ? y - 1 : y;
      return new Date(Date.UTC(fyStart - 1, 1, 1)).toISOString(); // prior FY start
    })();
    // Transaction__c / Case can be high volume — keep them to the past 24
    // months. Even at PPP scale that's a few thousand rows max.
    const TWO_YEARS_AGO_ISO = new Date(Date.now() - 730 * 86_400_000).toISOString();

    const quotasPromise: Promise<SnapshotQuota[]> = (async () => {
      try {
        const fields = "Id, User__c, FY__c, QuotaAssigned__c, Status__c, Allocation__c, QuotaType__c";
        const records: Array<Record<string, unknown>> = [];
        let result = await conn.query<Record<string, unknown>>(
          `SELECT ${fields} FROM TotalQuota__c WHERE Allocation__c = 'Owner' AND Status__c = 'Active' AND QuotaType__c = 'Field_Member'`
        );
        records.push(...result.records);
        while (!result.done && result.nextRecordsUrl) {
          result = await conn.queryMore<Record<string, unknown>>(result.nextRecordsUrl);
          records.push(...result.records);
        }
        console.log(`[SF] Pulled ${records.length} TotalQuota__c rows (Owner+Active+Field_Member) — PARALLEL`);
        return records.map<SnapshotQuota>((r) => ({
          id: r.Id as string,
          userId: (r.User__c as string) ?? "",
          // FY__c is sometimes stored as number, sometimes string. Normalize.
          fy: typeof r.FY__c === "number" ? r.FY__c : Number(r.FY__c) || 0,
          quotaAssigned: typeof r.QuotaAssigned__c === "number" ? (r.QuotaAssigned__c as number) : 0,
          status: (r.Status__c as string | null) ?? null,
          allocation: (r.Allocation__c as string | null) ?? null,
          quotaType: (r.QuotaType__c as string | null) ?? null,
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[SF] TotalQuota__c pull failed (KPI 1 % to Goal will be empty): ${msg}`);
        return [];
      }
    })();

    const subQuotasPromise: Promise<SnapshotSubQuota[]> = (async () => {
      try {
        // Joined to parent for rep attribution. SF returns nested object
        // when the relationship is selected — typed loosely below.
        const fields = "Id, TotalQuota__c, TotalQuota__r.User__c, TotalQuota__r.FY__c, Assigned__c, Attained__c, FiscalMonth__c";
        const records: Array<Record<string, unknown>> = [];
        let result = await conn.query<Record<string, unknown>>(
          `SELECT ${fields} FROM SubQuota__c WHERE TotalQuota__r.Allocation__c = 'Owner' AND TotalQuota__r.Status__c = 'Active' AND TotalQuota__r.QuotaType__c = 'Field_Member'`
        );
        records.push(...result.records);
        while (!result.done && result.nextRecordsUrl) {
          result = await conn.queryMore<Record<string, unknown>>(result.nextRecordsUrl);
          records.push(...result.records);
        }
        console.log(`[SF] Pulled ${records.length} SubQuota__c rows — PARALLEL`);
        return records.map<SnapshotSubQuota>((r) => {
          const parent = r["TotalQuota__r"] as Record<string, unknown> | undefined;
          const userId = (parent?.User__c as string) ?? "";
          const fy = typeof parent?.FY__c === "number" ? (parent.FY__c as number) : Number(parent?.FY__c) || 0;
          return {
            id: r.Id as string,
            totalQuotaId: (r.TotalQuota__c as string) ?? "",
            userId,
            fy,
            fiscalMonth: typeof r.FiscalMonth__c === "number" ? (r.FiscalMonth__c as number) : 0,
            assigned: typeof r.Assigned__c === "number" ? (r.Assigned__c as number) : 0,
            attained: typeof r.Attained__c === "number" ? (r.Attained__c as number) : 0,
          };
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[SF] SubQuota__c pull failed (KPI 1 monthly progress will be empty): ${msg}`);
        return [];
      }
    })();

    const transactionsPromise: Promise<SnapshotTransaction[]> = (async () => {
      try {
        // RecordType.DeveloperName for the 3 buckets. Plus WO + Opp linkage
        // for rep attribution. Payee__r.Name for commissions attribution.
        const fields = "Id, RecordType.DeveloperName, Amount__c, Date__c, PayeeType__c, Payee__r.Name, WorkOrder__c, WorkOrder__r.OwnerId, Opportunity__c";
        const records: Array<Record<string, unknown>> = [];
        let result = await conn.query<Record<string, unknown>>(
          `SELECT ${fields} FROM Transaction__c WHERE Date__c >= ${TWO_YEARS_AGO_ISO.split("T")[0]}`
        );
        records.push(...result.records);
        while (!result.done && result.nextRecordsUrl) {
          result = await conn.queryMore<Record<string, unknown>>(result.nextRecordsUrl);
          records.push(...result.records);
        }
        console.log(`[SF] Pulled ${records.length} Transaction__c rows (last 730d) — PARALLEL`);
        return records.map<SnapshotTransaction>((r) => {
          const rt = r["RecordType"] as Record<string, unknown> | undefined;
          const wo = r["WorkOrder__r"] as Record<string, unknown> | undefined;
          const payee = r["Payee__r"] as Record<string, unknown> | undefined;
          return {
            id: r.Id as string,
            recordType: (rt?.DeveloperName as string | null) ?? null,
            amount: typeof r.Amount__c === "number" ? (r.Amount__c as number) : 0,
            date: (r.Date__c as string) ?? "",
            payeeType: (r.PayeeType__c as string | null) ?? null,
            payeeName: (payee?.Name as string | null) ?? null,
            workOrderId: (r.WorkOrder__c as string | null) ?? null,
            workOrderOwnerId: (wo?.OwnerId as string | null) ?? null,
            opportunityId: (r.Opportunity__c as string | null) ?? null,
          };
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[SF] Transaction__c pull failed (KPI 8/9 money flow + commissions empty): ${msg}`);
        return [];
      }
    })();

    const reviewsPromise: Promise<SnapshotReview[]> = (async () => {
      try {
        const fields = "Id, GoodReview__c, BadReview__c, Removed__c, Account__c, Account__r.OwnerId, CreatedDate";
        const records: Array<Record<string, unknown>> = [];
        let result = await conn.query<Record<string, unknown>>(
          `SELECT ${fields} FROM Review__c WHERE CreatedDate >= ${CFY_START_ISO}`
        );
        records.push(...result.records);
        while (!result.done && result.nextRecordsUrl) {
          result = await conn.queryMore<Record<string, unknown>>(result.nextRecordsUrl);
          records.push(...result.records);
        }
        console.log(`[SF] Pulled ${records.length} Review__c rows (since prior FY start) — PARALLEL`);
        return records.map<SnapshotReview>((r) => {
          const acct = r["Account__r"] as Record<string, unknown> | undefined;
          return {
            id: r.Id as string,
            isGood: Boolean(r.GoodReview__c),
            isBad: Boolean(r.BadReview__c),
            isRemoved: Boolean(r.Removed__c),
            accountId: (r.Account__c as string | null) ?? null,
            accountOwnerId: (acct?.OwnerId as string | null) ?? null,
            createdDate: (r.CreatedDate as string) ?? "",
          };
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[SF] Review__c pull failed (KPI 7 reviews will be empty): ${msg}`);
        return [];
      }
    })();

    const casesPromise: Promise<SnapshotCase[]> = (async () => {
      try {
        // Customer-facing case types only (per BUSINESS_RULES.md).
        // Opportunity__c is a custom lookup on Case in PPP's org.
        const fields = "Id, CaseNumber, Type, Status, CreatedDate, Opportunity__c, Opportunity__r.OwnerId";
        const customerTypes = "'Estimator No Show','Waiting for Estimate','Dissatisfied Customer','Balance Owed','Service Call','Other'";
        const records: Array<Record<string, unknown>> = [];
        let result = await conn.query<Record<string, unknown>>(
          `SELECT ${fields} FROM Case WHERE Type IN (${customerTypes}) AND CreatedDate >= ${CFY_START_ISO}`
        );
        records.push(...result.records);
        while (!result.done && result.nextRecordsUrl) {
          result = await conn.queryMore<Record<string, unknown>>(result.nextRecordsUrl);
          records.push(...result.records);
        }
        console.log(`[SF] Pulled ${records.length} Case rows (customer-facing types since prior FY) — PARALLEL`);
        return records.map<SnapshotCase>((r) => {
          const opp = r["Opportunity__r"] as Record<string, unknown> | undefined;
          return {
            id: r.Id as string,
            caseNumber: (r.CaseNumber as string | null) ?? null,
            type: (r.Type as string | null) ?? null,
            status: (r.Status as string | null) ?? null,
            createdDate: (r.CreatedDate as string) ?? "",
            opportunityId: (r.Opportunity__c as string | null) ?? null,
            opportunityOwnerId: (opp?.OwnerId as string | null) ?? null,
          };
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[SF] Case pull failed (KPI 7 complaints will be empty): ${msg}`);
        return [];
      }
    })();

    // Await the Account + Quote + PaintColor promises that have been running
    // in parallel with the WO query above + the new rep-performance pulls.
    const [accounts, quotes, paintColors, quotas, subQuotas, transactions, reviews, cases] = await Promise.all([
      accountsPromise,
      quotesPromise,
      paintColorsPromise,
      quotasPromise,
      subQuotasPromise,
      transactionsPromise,
      reviewsPromise,
      casesPromise,
    ]);

    // WOLI fetch runs LAST because it explicitly batches by WorkOrderId IN
    // (...) — needs the WO Ids first. We only scope to the active-WO subset
    // we actually care about (workTypes that aren't Estimate/Appointment +
    // statuses that aren't closed/completed), so the IN-clause stays small
    // and the network round-trip stays predictable. Closed/completed WOs
    // can still have their WOLIs surfaced via lifetime queries later — for
    // now Materials Ordering only needs the active set.
    const woliEligibleIds = workOrders
      .filter((w) => {
        const wt = (w.workTypeName ?? "").toLowerCase();
        if (
          wt.includes("estimate") ||
          wt.includes("appointment") ||
          wt.includes("inspection") ||
          wt.includes("consultation")
        ) {
          return false;
        }
        const s = (w.status ?? "").toLowerCase();
        if (
          s.includes("paid in full") ||
          s.includes("complete") ||
          s.includes("cancel") ||
          s.includes("closed") ||
          s.includes("void") ||
          s.includes("abandoned")
        ) {
          return false;
        }
        return true;
      })
      .map((w) => w.id);
    const woLineItems = await wrapWoliFetch(woliEligibleIds);

    // Sandbox detection — instance URL contains "sandbox" for any sandbox org.
    const instanceUrl = conn.instanceUrl ?? null;
    const isSandbox = instanceUrl ? /sandbox\.my\.salesforce\.com/i.test(instanceUrl) : false;

    return {
      reps,
      opportunities,
      workOrders,
      accounts,
      quotes,
      woLineItems,
      paintColors,
      quotas,
      subQuotas,
      transactions,
      reviews,
      cases,
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
