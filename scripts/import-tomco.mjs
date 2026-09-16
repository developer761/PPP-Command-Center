/**
 * Tomco → Commercial Command Center. The migration runner.
 *
 * Salesforce is READ-ONLY here; every write lands in Supabase.
 * Spec: docs/TOMCO_MIGRATION_PLAN.md. Karan's rule: every KPI and total lines
 * up to the cent.
 *
 *   node --env-file=.env.local scripts/import-tomco.mjs --stage=accounts
 *       dry run — prints what it WOULD write, touches nothing
 *
 *   node --env-file=.env.local scripts/import-tomco.mjs --stage=accounts --commit
 *   node --env-file=.env.local scripts/import-tomco.mjs --stage=all --commit
 *
 *   node --env-file=.env.local scripts/import-tomco.mjs --reconcile
 *       compares what landed against Salesforce, writes nothing, exits 1 on any
 *       difference of a cent
 *
 * Every stage is idempotent: commercial_import_map records Salesforce id -> our
 * row, so a re-run updates instead of duplicating. Rows are inserted directly,
 * never through the app helpers, so importing 132 deals cannot fire 132 emails,
 * Slack posts and status cascades.
 */
import { createClient } from "@supabase/supabase-js";
import jsforce from "jsforce";
import {
  cents,
  dealStatusForWorkOrder,
  jobStatusForWorkOrder,
  isClosedWorkOrder,
  OPEN_BID_STATUS,
  openBidStatus,
  planInvoice,
  planInvoiceColumns,
  adjustmentLabel,
  invoiceStatus,
  dueDateFor,
  purchaseCategory,
  isReimbursement,
  employeeFromCrewWorker,
  ymd,
} from "../lib/commercial/import/mapping.ts";

/**
 * A Salesforce day → the instant a TIMESTAMPTZ column should hold.
 *
 * `ymd()` returns a bare "2025-08-04", and Postgres reads that into a
 * timestamptz as UTC MIDNIGHT. Render it in Eastern and it is the 3rd — every
 * invoice, payment and receipt a day earlier than Salesforce shows, and an
 * invoice dated the 1st filing into the previous quarter on the Cash Flow and
 * Sales Tax reports. 16:00 UTC is noon-ish ET and stays on the intended day in
 * both EST and EDT; it is the same anchor as `anchorDateOnlyIso` in
 * lib/commercial/dates.ts, which exists for exactly this.
 *
 * Only for timestamptz. The DATE columns (a deal's proposed_start_at, a
 * project's closed_out_at) take the bare day and must NOT be anchored.
 */
const at = (day) => (day ? `${day}T16:00:00.000Z` : null);

const TOMCO = "Corporate_Name__c='Tomco Painting'";
const STAGES = [
  // Invoices BEFORE change orders: a carried-over change order has to point at
  // the invoice that already billed it, or the platform offers to bill it a
  // second time. Nothing in the invoice stage needs a change order — the
  // contract figure it uses already includes them.
  "accounts", "contacts", "deals", "jobs", "invoices", "change-orders",
  "payments", "costs", "employees", "crews", "attendance", "projects", "files", "dates",
];

const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const RECONCILE = args.includes("--reconcile");
/**
 * Let Salesforce overwrite rows a person has edited on the platform.
 *
 * OFF by default, and it should stay off for the whole dual-run: from go-live
 * Tomco works in both systems for about two weeks, and the platform is the one
 * becoming the system of record. Pass this only to deliberately re-baseline
 * from Salesforce.
 */
const SF_WINS = args.includes("--salesforce-wins");
/**
 * Re-baseline: record "the platform as it stands right now is what we last
 * wrote", for every mapped row, without touching any data.
 *
 * The guard compares a row's `updated_at` against the moment the importer last
 * wrote it — and rows written before the guard existed have no such record, so
 * every one of them looks edited-by-a-human and Salesforce updates stop coming
 * through. Run this ONCE after everything is in agreement, and at cutover.
 */
const REBASELINE = args.includes("--rebaseline");
const stageArg = (args.find((a) => a.startsWith("--stage=")) ?? "--stage=all").split("=")[1];
const wanted = stageArg === "all" ? STAGES : stageArg.split(",");

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

async function salesforce() {
  const { data: cred, error } = await sb.from("system_credentials").select("*");
  if (error) throw new Error(`credentials: ${error.message}`);
  const get = (k) => cred.find((r) => (r.key ?? r.name ?? "").includes(k))?.value;
  const conn = new jsforce.Connection({
    oauth2: {
      loginUrl: process.env.SF_LOGIN_URL,
      clientId: process.env.SF_CONSUMER_KEY,
      clientSecret: process.env.SF_CONSUMER_SECRET,
    },
    version: "60.0",
  });
  const rr = await conn.oauth2.refreshToken(get("refresh"));
  conn.accessToken = rr.access_token;
  conn.instanceUrl = rr.instance_url ?? get("instance");
  // A write to Salesforce would be a bug with consequences; make it impossible
  // rather than merely intended.
  for (const m of ["create", "update", "upsert", "destroy", "delete", "insert"]) {
    conn.sobject = new Proxy(conn.sobject, {
      apply(target, thisArg, argv) {
        const o = Reflect.apply(target, thisArg, argv);
        return new Proxy(o, {
          get(t, prop) {
            if (typeof prop === "string" && ["create", "update", "upsert", "destroy", "delete", "insert"].includes(prop)) {
              throw new Error(`refusing to ${prop} in Salesforce — this migration is read-only`);
            }
            return t[prop];
          },
        });
      },
    });
    break;
  }
  return conn;
}

async function all(conn, soql) {
  const out = [];
  let res = await conn.query(soql);
  out.push(...res.records);
  while (!res.done) {
    res = await conn.queryMore(res.nextRecordsUrl);
    out.push(...res.records);
  }
  return out;
}

// ─── the map: Salesforce id -> our row ──────────────────────────────────────
const MAP = new Map(); // `${entity}:${sfId}` -> row_id
/**
 * WHEN this importer last wrote each row, as the DATABASE clock saw it.
 *
 * This is what makes a dual-run safe. From go-live Tomco works in both systems
 * for about two weeks, and a sync that blindly re-applies Salesforce would undo
 * real work here — Brendan moves a job to Scheduled, the next run reads "Work
 * In Progress" from Salesforce and moves it back. Comparing a row's current
 * `updated_at` against the moment we last wrote it says whether a PERSON has
 * touched it since. If they have, Salesforce loses.
 */
const WROTE_AT = new Map(); // `${entity}:${sfId}` -> ISO timestamp

async function loadMap() {
  // PAGINATE, and order by the WHOLE key.
  //
  // Two bugs lived here. `.limit(20000)` returned 1000 rows, because PostgREST
  // caps a response at its max-rows setting and says nothing about the rest —
  // so the importer saw a third of the map, could not find the employees it had
  // just written, and would have RE-INSERTED every row it could not see.
  // Then paginating on `sf_id` alone was not enough either: one work order has
  // an invoice, a job and a work_order row under the same sf_id, and a
  // non-unique sort lets tied rows fall between pages.
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from("commercial_import_map")
      .select("sf_id, entity, row_id, updated_at")
      .order("sf_id", { ascending: true })
      .order("entity", { ascending: true })
      .range(from, from + 999);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) {
        console.error("commercial_import_map is missing — apply migration 20260916130000 first.");
        process.exit(1);
      }
      throw new Error(error.message);
    }
    for (const r of data ?? []) {
      MAP.set(`${r.entity}:${r.sf_id}`, r.row_id);
      WROTE_AT.set(`${r.entity}:${r.sf_id}`, r.updated_at);
    }
    if (!data || data.length < 1000) break;
    from += data.length;
  }
  console.log(`import map: ${MAP.size} row(s) already imported`);
}
const mapped = (entity, sfId) => MAP.get(`${entity}:${sfId}`) ?? null;

async function remember(entity, sfId, rowId, notes, wroteAt) {
  MAP.set(`${entity}:${sfId}`, rowId);
  // Prefer the timestamp the DATABASE put on the row we just wrote. Using this
  // machine's clock instead would make every row look edited-by-a-human on the
  // next run if the two clocks disagree by a second.
  const stamp = wroteAt ?? new Date().toISOString();
  if (COMMIT) WROTE_AT.set(`${entity}:${sfId}`, stamp);
  if (!COMMIT) return;
  const { error } = await sb
    .from("commercial_import_map")
    .upsert({ sf_id: sfId, entity, row_id: rowId, notes: notes ?? null, updated_at: stamp }, { onConflict: "sf_id,entity" });
  if (error) throw new Error(`import map (${entity} ${sfId}): ${error.message}`);
}

/**
 * The columns each table actually has, read from PostgREST's own schema.
 *
 * A dry run never attempts an insert, so it cannot discover that a column does
 * not exist — the import would rehearse perfectly and then fail on the first
 * real write, halfway through a stage. Checking the row's keys against the
 * schema closes that gap.
 */
const COLUMNS = new Map();
async function loadColumns() {
  const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/`, {
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      Accept: "application/openapi+json",
    },
  });
  const spec = await res.json();
  for (const [table, def] of Object.entries(spec.definitions ?? {})) {
    COLUMNS.set(table, new Set(Object.keys(def.properties ?? {})));
  }
}

function checkColumns(table, row, report) {
  const known = COLUMNS.get(table);
  if (!known) { report.skipped.push(`${table}: not in the schema at all`); return false; }
  const unknown = Object.keys(row).filter((k) => !known.has(k));
  if (unknown.length) {
    const msg = `${table}: no such column ${unknown.join(", ")}`;
    if (!report.schemaErrors) report.schemaErrors = new Set();
    if (!report.schemaErrors.has(msg)) { report.schemaErrors.add(msg); report.skipped.push(msg); }
    return false;
  }
  return true;
}

/** Insert or update one row, keyed by its Salesforce id. Returns the row id. */
async function put(entity, sfId, table, row, report) {
  const existing = mapped(entity, sfId);
  report.total += 1;
  if (!checkColumns(table, row, report)) return null;
  if (!COMMIT) {
    if (report.sample.length < 3) report.sample.push(row);
    report.would += 1;
    // Remember the pretend id IN MEMORY (never in the database), so the later
    // stages can resolve their parents and the dry run rehearses the whole
    // chain. Without this every stage after accounts reports "not imported
    // yet" and the rehearsal proves nothing.
    const pretend = existing ?? `dry-run-${entity}-${report.total}`;
    MAP.set(`${entity}:${sfId}`, pretend);
    return pretend;
  }
  if (existing) {
    // THE PLATFORM WINS. If somebody has edited this row here since the last
    // sync, Salesforce does not get to undo it — the row is left alone and the
    // clash is reported, because two people quietly disagreeing is worse than
    // either answer. `--salesforce-wins` overrides, deliberately and loudly.
    if (!SF_WINS && (await editedHere(table, existing, `${entity}:${sfId}`))) {
      report.kept = (report.kept ?? 0) + 1;
      report.conflicts = report.conflicts ?? [];
      if (report.conflicts.length < 40) report.conflicts.push(`${table} ${existing} (Salesforce ${sfId})`);
      return existing;
    }
    const hasStamp = COLUMNS.get(table)?.has("updated_at");
    const { data: upd, error } = hasStamp
      ? await sb.from(table).update(row).eq("id", existing).select("updated_at").single()
      : await sb.from(table).update(row).eq("id", existing);
    if (error) throw new Error(`${table} update ${sfId}: ${error.message}`);
    report.updated += 1;
    await remember(entity, sfId, existing, undefined, upd?.updated_at);
    return existing;
  }
  const hasStamp = COLUMNS.get(table)?.has("updated_at");
  const { data, error } = await sb.from(table).insert(row).select(hasStamp ? "id, updated_at" : "id").single();
  if (error) throw new Error(`${table} insert ${sfId}: ${error.message}`);
  await remember(entity, sfId, data.id, undefined, data.updated_at);
  report.inserted += 1;
  return data.id;
}

/**
 * Has a person changed this row on the platform since the importer last wrote
 * it?
 *
 * `updated_at` is stamped by a trigger on every write, ours included — so the
 * question is only answerable by comparing it against the moment WE last wrote,
 * which `commercial_import_map.updated_at` records. A row with no `updated_at`
 * column cannot be judged, so it is treated as untouched.
 *
 * Timestamps are read in bulk, once per table, and cached.
 */
const ROW_STAMPS = new Map(); // table -> Map(id -> updated_at)
async function editedHere(table, rowId, mapKey) {
  if (!COLUMNS.get(table)?.has("updated_at")) return false;
  const lastWrote = WROTE_AT.get(mapKey);
  if (!lastWrote) return false; // never written by us — nothing to protect
  if (!ROW_STAMPS.has(table)) {
    const stamps = new Map();
    let from = 0;
    for (;;) {
      const { data, error } = await sb.from(table).select("id, updated_at").order("id").range(from, from + 999);
      if (error) throw new Error(`${table} timestamps: ${error.message}`);
      for (const r of data ?? []) stamps.set(r.id, r.updated_at);
      if (!data || data.length < 1000) break;
      from += data.length;
    }
    ROW_STAMPS.set(table, stamps);
  }
  const current = ROW_STAMPS.get(table).get(rowId);
  if (!current) return false;
  // A millisecond of slack: our own write sets the row stamp and the map stamp
  // from the same instant, and they are stored at different precisions.
  return new Date(current).getTime() - new Date(lastWrote).getTime() > 1000;
}

function newReport(stage) {
  return { stage, total: 0, would: 0, inserted: 0, updated: 0, kept: 0, conflicts: [], skipped: [], sample: [], notes: [] };
}

function printReport(r) {
  const head = COMMIT
    ? `${r.stage}: ${r.inserted} inserted, ${r.updated} updated${r.kept ? `, ${r.kept} kept (yours)` : ""}`
    : `${r.stage}: would write ${r.would} row(s)`;
  console.log(`\n${head}`);
  for (const n of r.notes ?? []) console.log(`   ${n}`);
  if (r.kept) {
    console.log(`   🛡  ${r.kept} row(s) KEPT as they are — edited on the platform since the last sync, so Salesforce did not overwrite them:`);
    for (const c of (r.conflicts ?? []).slice(0, 8)) console.log(`     - ${c}`);
    if ((r.conflicts ?? []).length > 8) console.log(`     …and ${r.conflicts.length - 8} more`);
  }
  if (r.skipped.length) {
    console.log(`   ${r.skipped.length} skipped:`);
    for (const s of r.skipped.slice(0, 8)) console.log(`     - ${s}`);
    if (r.skipped.length > 8) console.log(`     …and ${r.skipped.length - 8} more`);
  }
  if (!COMMIT && r.sample.length) {
    console.log("   first rows:");
    for (const s of r.sample) console.log(`     ${JSON.stringify(s).slice(0, 190)}`);
  }
}

// ─── Salesforce, fetched once and shared by the stages ──────────────────────
const SF = {};
async function loadSalesforce(conn) {
  if (SF.loaded) return SF;
  SF.opps = await all(conn, `SELECT Id, Name, StageName, IsClosed, IsWon, CloseDate, CreatedDate, LastModifiedDate, AccountId,
      Primary_Contact__c, Primary_Contact__r.Name, Primary_Contact__r.Email, Primary_Contact__r.Phone, Primary_Contact__r.Title,
      QuotedSubtotalWithChangeOrder__c, Quote_Subtotal__c, TotalAmount__c, Amount, Estimation_Address__c, Service_Territory__c,
      Start_Date__c, End_Date__c, Owner.Name, Estimator__r.Name, ProjectManager__r.Name
      FROM Opportunity WHERE ${TOMCO}`);
  SF.wos = await all(conn, `SELECT Id, WorkOrderNumber, Name__c, Status, Opportunity__c, AccountId, Account.Name,
      Street, City, State, PostalCode, StartDate, EndDate, CreatedDate,
      Quoted_Subtotal_with_Change_Order__c, Original_Quoted_Subtotal__c, TotalChangeOrder__c, Tax, GrandTotal__c,
      TotalPaymentsIn__c, BalanceOwed__c, Customer_PO__c, Payment_Terms__c
      FROM WorkOrder WHERE (${TOMCO} OR Opportunity__r.${TOMCO}) AND Status != 'Canceled'`);
  const woIds = SF.wos.map((w) => `'${w.Id}'`).join(",");
  const oppIds = SF.opps.map((o) => `'${o.Id}'`).join(",");
  SF.accounts = await all(conn, `SELECT Id, Name, CreatedDate, Phone, Website, BillingStreet, BillingCity, BillingState, BillingPostalCode,
      ShippingStreet, ShippingCity, ShippingState, ShippingPostalCode FROM Account WHERE Id IN (SELECT AccountId FROM Opportunity WHERE ${TOMCO})`);
  SF.contacts = await all(conn, `SELECT Id, Name, CreatedDate, FirstName, LastName, Email, Phone, MobilePhone, Title, AccountId
      FROM Contact WHERE Id IN (SELECT Primary_Contact__c FROM Opportunity WHERE ${TOMCO})`);
  SF.tx = await all(conn, `SELECT Id, Name, RecordType.DeveloperName, PayeeType__c, WorkOrder__c, Opportunity__c,
      Amount__c, Date__c, Method__c, Description__c, ReferenceId__c, Deposited__c,
      RetailVendor__c, RetailVendor__r.Name, Payee__c, Payee__r.Name
      FROM Transaction__c WHERE WorkOrder__c IN (${woIds}) OR Opportunity__c IN (${oppIds})`);
  SF.attendance = await all(conn, `SELECT Id, WorkOrder__c, Crew__c, Crew__r.Name, Crew_Worker__c, CreatedDate, StartDate__c, EndDate__c,
      LengthofDay__c, ActualLaborDays__c, Hours_Worked__c, Paid__c, PaidAmount__c, Notes__c
      FROM WorkOrderCrew__c WHERE WorkOrder__c IN (${woIds})`);
  SF.lines = await all(conn, `SELECT Id, WorkOrderId, LineItemNumber, Description, Quantity, UnitPrice, Subtotal, TotalPrice,
      Status, ProductName__c, ChangeOrderRelated__c, SortOrder__c FROM WorkOrderLineItem WHERE WorkOrderId IN (${woIds})`);
  // Files: everything attached to a Tomco opportunity or work order. With
  // Salesforce being retired, whatever is not imported is gone.
  const linkTargets = [...SF.opps.map((o) => o.Id), ...SF.wos.map((w) => w.Id)];
  SF.links = [];
  for (let i = 0; i < linkTargets.length; i += 150) {
    SF.links.push(...await all(conn, `SELECT ContentDocumentId, LinkedEntityId FROM ContentDocumentLink
      WHERE LinkedEntityId IN (${linkTargets.slice(i, i + 150).map((id) => `'${id}'`).join(",")})`));
  }
  // And the links from TRANSACTIONS, which say which receipt belongs to which
  // cost. Every one of these 729 documents is also linked to its opportunity or
  // work order, so nothing new is downloaded and nothing was being lost — but
  // without this the receipts arrive as a flat list of 730 files on the deal,
  // and no cost line can show the receipt behind it.
  SF.txLinks = [];
  const txIds = SF.tx.map((t) => t.Id);
  for (let i = 0; i < txIds.length; i += 150) {
    SF.txLinks.push(...await all(conn, `SELECT ContentDocumentId, LinkedEntityId FROM ContentDocumentLink
      WHERE LinkedEntityId IN (${txIds.slice(i, i + 150).map((id) => `'${id}'`).join(",")})`));
  }

  const docIds = [...new Set(SF.links.map((l) => l.ContentDocumentId))];
  SF.docs = [];
  for (let i = 0; i < docIds.length; i += 200) {
    SF.docs.push(...await all(conn, `SELECT Id, Title, CreatedDate, FileExtension, FileType, ContentSize, LatestPublishedVersionId
      FROM ContentDocument WHERE Id IN (${docIds.slice(i, i + 200).map((d) => `'${d}'`).join(",")})`));
  }
  SF.loaded = true;
  // Everything we import hangs off the 92 LIVE work orders. Transactions and
  // attendance also exist on canceled ones (5 and 6 of them) and on lost
  // opportunities we are not importing — the reconciliation has to compare
  // like with like, or it reports a difference that is actually correct.
  SF.liveWoIds = new Set(SF.wos.map((w) => w.Id));
  SF.txInScope = SF.tx.filter((t) => SF.liveWoIds.has(t.WorkOrder__c));
  SF.txOutOfScope = SF.tx.filter((t) => !SF.liveWoIds.has(t.WorkOrder__c));
  SF.attendanceInScope = SF.attendance.filter((a) => SF.liveWoIds.has(a.WorkOrder__c));
  SF.woByOpp = new Map();
  for (const w of SF.wos) if (w.Opportunity__c) SF.woByOpp.set(w.Opportunity__c, w);
  return SF;
}

// ─── vendors, already imported, matched by their Salesforce account id ──────
let VENDORS = null;
async function vendorBySfId(sfId) {
  if (!VENDORS) {
    const { data } = await sb.from("commercial_vendors").select("id, name, kind, sf_account_ids").is("deleted_at", null);
    VENDORS = new Map();
    for (const v of data ?? []) for (const s of v.sf_account_ids ?? []) VENDORS.set(s, v);
  }
  return sfId ? VENDORS.get(sfId) ?? null : null;
}

// ─── stages ─────────────────────────────────────────────────────────────────

async function stageAccounts() {
  const r = newReport("accounts");
  for (const a of SF.accounts) {
    await put("account", a.Id, "commercial_accounts", {
      company_name: a.Name,
      phone: a.Phone || null,
      website: a.Website || null,
      billing_street: a.BillingStreet || null,
      billing_city: a.BillingCity || null,
      billing_state: a.BillingState || null,
      billing_zip: a.BillingPostalCode || null,
      site_street: a.ShippingStreet || null,
      site_city: a.ShippingCity || null,
      site_state: a.ShippingState || null,
      site_zip: a.ShippingPostalCode || null,
      notes: "Imported from Salesforce",
    }, r);
  }
  return r;
}

async function stageContacts() {
  const r = newReport("contacts");
  // ONE primary per account — migration 026 enforces it with a partial unique
  // index on (account_id) WHERE is_primary.
  //
  // Every contact used to be written as the primary, which meant the second
  // contact on a GC was not an upsert (the ON CONFLICT names a different
  // constraint) but a plain INSERT that hit that index — and the error said
  // "duplicate key", which the filter below swallowed as harmless. 28 of
  // Tomco's 93 contacts were dropped that way, silently, and every account
  // showed exactly one contact. The first contact on an account is the primary;
  // the rest are linked as ordinary contacts, which is what they are.
  const primaryTaken = new Set();
  for (const c of SF.contacts) {
    // Prefer the account the contact is attached to; fall back to the account
    // of the Tomco opportunity that names them, since a contact can sit on a
    // parent account that has no Tomco work of its own.
    const viaOpp = SF.opps.find((o) => o.Primary_Contact__c === c.Id)?.AccountId;
    const accountId = mapped("account", c.AccountId) ?? mapped("account", viaOpp);
    const contactId = await put("contact", c.Id, "commercial_contacts", {
      full_name: c.Name || [c.FirstName, c.LastName].filter(Boolean).join(" ") || "Contact",
      email: c.Email || null,
      phone: c.Phone || c.MobilePhone || null,
      title: c.Title || null,
    }, r);
    if (!accountId) {
      r.skipped.push(`${c.Name}: its GC account is not imported yet (run --stage=accounts first)`);
      continue;
    }
    const isPrimary = !primaryTaken.has(accountId);
    primaryTaken.add(accountId);
    if (COMMIT && contactId) {
      const { error } = await sb.from("commercial_account_contacts")
        .upsert({ account_id: accountId, contact_id: contactId, role: "decision_maker", is_primary: isPrimary }, { onConflict: "account_id,contact_id,role" });
      // NOT swallowed. A link that does not land is a person Katie cannot ring.
      if (error) r.skipped.push(`${c.Name}: not linked to its GC — ${error.message}`);
    }
  }
  return r;
}

/**
 * The contract a won job is measured against: Salesforce's quoted subtotal,
 * plus anything its balance owes beyond the invoice (see the change-order
 * stage). Without the second part the deal reads "over-billed" against its own
 * contract.
 */
function contractCentsFor(wo, opp) {
  const base = cents(wo?.Quoted_Subtotal_with_Change_Order__c ?? opp.QuotedSubtotalWithChangeOrder__c);
  if (!wo) return base;
  const plan = planInvoice({
    quotedSubtotalWithCo: wo.Quoted_Subtotal_with_Change_Order__c,
    totalChangeOrder: wo.TotalChangeOrder__c,
    tax: wo.Tax,
    grandTotal: wo.GrandTotal__c,
    totalPaymentsIn: wo.TotalPaymentsIn__c,
    balanceOwed: wo.BalanceOwed__c,
  });
  return base + (!plan.isOverpaid && plan.adjustmentCents > 0 ? plan.adjustmentCents : 0);
}

/**
 * What an open bid is worth. Salesforce keeps this in a different field from the
 * won-job contract figure, and only this one is populated on live bids.
 */
function bidCentsFor(o) {
  // NO fallback to TotalAmount__c. It is populated on all 39 open bids, but
  // Tomco's own "Opportunity Pipeline Manager" report sums Quote_Subtotal__c
  // and prints a blank for the four that have none — so falling back added
  // $119,690 the people reading this report have never seen. Their report is
  // the spec: $2,116,612.79.
  return cents(o.Quote_Subtotal__c ?? o.QuotedSubtotalWithChangeOrder__c);
}

async function stageDeals() {
  const r = newReport("deals");
  for (const o of SF.opps) {
    // No lost jobs (Karan, 2026-09-15) — we do not BRING them across.
    //
    // But one that has already come across and has SINCE been lost in
    // Salesforce has to be closed here, or it sits in the pipeline for ever:
    // "Jefferson's Ferry Building Expansion" was still an open bid on this
    // platform after Tomco had marked it lost. Skipping it outright is what
    // left it there. This matters for the whole dual-run, where deals will keep
    // being decided in Salesforce while the platform is live.
    if (o.IsClosed && !o.IsWon) {
      if (!mapped("deal", o.Id)) continue;
      await put("deal", o.Id, "commercial_opportunities", {
        status: "pre_sale_closed",
        sub_status: "lost",
        // WITHOUT A DECIDED DATE A LOST DEAL IS INVISIBLE. The Win/Loss report
        // filters on `decided_at IS NOT NULL`, so a loss with no date is not
        // counted as a loss — and a win rate computed over 92 wins and zero
        // countable losses is 100%, for ever, on every GC account.
        decided_at: ymd(o.CloseDate) ?? ymd(o.LastModifiedDate),
        bid_value_low_cents: null,
        bid_value_high_cents: null,
      }, r);
      r.notes.push(`${o.Name}: lost in Salesforce since the import — closed here too`);
      continue;
    }
    const accountId = mapped("account", o.AccountId);
    if (!accountId) { r.skipped.push(`${o.Name}: no imported GC account`); continue; }
    const wo = SF.woByOpp.get(o.Id);
    const st = wo ? dealStatusForWorkOrder(wo.Status) : openBidStatus(o.StageName);
    if (!st.status) { r.skipped.push(`${o.Name}: unmapped work order status "${wo?.Status}"`); continue; }
    await put("deal", o.Id, "commercial_opportunities", {
      account_id: accountId,
      primary_contact_id: mapped("contact", o.Primary_Contact__c),
      title: (o.Name || "Job").slice(0, 200),
      status: st.status,
      sub_status: st.subStatus,
      source: "other",
      probability_pct: o.IsWon ? 100 : 50,
      property_street: wo?.Street || o.Estimation_Address__c || null,
      property_city: wo?.City || null,
      property_state: wo?.State || null,
      property_zip: wo?.PostalCode || null,
      proposed_start_at: ymd(wo?.StartDate ?? o.Start_Date__c),
      proposed_end_at: ymd(wo?.EndDate ?? o.End_Date__c),
      decided_at: o.IsWon ? ymd(o.CloseDate) : null,
      // THE DAY THE JOB CLOSED OUT, on the deal — not just on its project.
      //
      // Both tables have a `closed_out_at`, and only the project's was being
      // written. But `wasWonInPeriod` reads the DEAL's, and the Win/Loss report
      // skips any post_sale_closed deal without one
      // (lib/commercial/win-loss/reports.ts). With it null on all 56 closed
      // jobs, Alex sets Win/Loss to FY26 expecting 92 wins and $2.7M and gets
      // an empty report — the dashboard's won-in-period figures go with it.
      closed_out_at: st.status === "post_sale_closed" ? (ymd(wo?.EndDate) ?? ymd(wo?.StartDate) ?? ymd(o.CloseDate)) : null,
      win_loss_debriefed_at: o.IsWon ? new Date().toISOString() : null,
      ppp_job_number: wo?.WorkOrderNumber || null,
      // An open bid with no bid value makes the whole Pipeline report read $0:
      // 40 open opportunities, no value, no weighted pipeline, no win
      // probability. Salesforce's quoted subtotal IS the bid.
      // THE BID IS `Quote_Subtotal__c`. Not QuotedSubtotalWithChangeOrder__c,
      // which is filled on exactly ONE of Tomco's 39 open opportunities — so
      // the Pipeline report read "$500 · $13 avg deal" against a book worth
      // $2.1M. Quote_Subtotal__c totals $2,116,612.79, which is the figure
      // Tomco's own "Opportunity Pipeline Manager" report prints, to the cent.
      bid_value_low_cents: o.IsWon ? null : bidCentsFor(o),
      bid_value_high_cents: o.IsWon ? null : bidCentsFor(o),
      accepted_contract_cents: o.IsWon ? contractCentsFor(wo, o) : null,
      accepted_contract_set_at: o.IsWon ? new Date().toISOString() : null,
      created_at: o.CreatedDate,
    }, r);
  }
  return r;
}

async function stageJobs() {
  const r = newReport("jobs");
  for (const w of SF.wos) {
    const dealId = mapped("deal", w.Opportunity__c);
    if (!dealId) { r.skipped.push(`${w.WorkOrderNumber}: its deal is not imported`); continue; }
    const accountId = mapped("account", w.AccountId) ?? mapped("account", SF.opps.find((o) => o.Id === w.Opportunity__c)?.AccountId);
    // commercial_work_orders is the CREW's work order — scope and schedule, no
    // address of its own (the deal carries that) and `work_notes`, not `notes`.
    await put("work_order", w.Id, "commercial_work_orders", {
      opportunity_id: dealId,
      account_id: accountId,
      status: "sent",
      // A work order marked `sent` with no `sent_at` reads as NOT sent: the
      // dashboard's Jobs-in-flight strip flags "work order not sent" on every
      // active Tomco job, and the deal page hides "Last sent to Field Ops".
      // These went out to the crews months ago; the day the work started is the
      // closest honest stamp Salesforce has.
      sent_at: at(ymd(w.StartDate) ?? ymd(w.CreatedDate)),
      scheduled_start_date: ymd(w.StartDate),
      scheduled_end_date: ymd(w.EndDate),
      area_label: (w.Name__c || w.WorkOrderNumber || "Work order").slice(0, 120),
      scope_line_item_ids: [],
      work_notes: `Imported from Salesforce work order ${w.WorkOrderNumber}.`,
    }, r);
  }
  return r;
}

async function stageChangeOrders() {
  const r = newReport("change-orders");
  for (const w of SF.wos) {
    const plan = planInvoice({
      quotedSubtotalWithCo: w.Quoted_Subtotal_with_Change_Order__c,
      totalChangeOrder: w.TotalChangeOrder__c,
      tax: w.Tax,
      grandTotal: w.GrandTotal__c,
      totalPaymentsIn: w.TotalPaymentsIn__c,
      balanceOwed: w.BalanceOwed__c,
    });
    // A job that OWES more than its invoice explains is billing work the
    // contract does not cover, and the deal page called it "103% billed ·
    // OVER-BILLED $1.6k". Salesforce has no change order for it, but its own
    // balance says the work happened — so it goes into the contract as one,
    // which is what an unlogged extra IS.
    const residual = !plan.isOverpaid && plan.adjustmentCents > 0 ? plan.adjustmentCents : 0;
    const amount = cents(w.TotalChangeOrder__c) + residual;
    if (amount === 0) continue;
    const dealId = mapped("deal", w.Opportunity__c);
    const accountId = mapped("account", w.AccountId) ?? mapped("account", SF.opps.find((o) => o.Id === w.Opportunity__c)?.AccountId);
    if (!dealId || !accountId) { r.skipped.push(`${w.WorkOrderNumber}: deal or account missing`); continue; }
    await put("change_order", w.Id, "commercial_change_orders", {
      opportunity_id: dealId,
      account_id: accountId,
      co_number: 1,
      // CUSTOMER-FACING TEXT. `title` and `description` are both printed on the
      // change-order PDF, under "Description of change" — so the GC reads them.
      // They used to carry the migration's own explanation ("Salesforce tracks
      // change-order VALUE per job, not individual change orders…"), which is
      // an internal note about how we moved the data and has no business on a
      // document that leaves the building. The explanation now lives on the
      // import map row, which is exactly what its `notes` column is for.
      title: "Approved change orders",
      description: residual
        ? `The total approved change-order value on this project, including $${(residual / 100).toFixed(2)} of additional approved work billed against this job.`
        : "The total approved change-order value on this project.",
      amount_cents: amount,
      status: "approved",
      decided_at: at(ymd(w.StartDate) ?? ymd(w.CreatedDate)),
      // ALREADY BILLED. The invoice subtotal is built from
      // Quoted_Subtotal_with_Change_Order__c, which includes this money — the
      // GC has been charged for it. Left unset, every carried-over change order
      // reads "Approved, unbilled" on the reports index and the deal panel
      // offers a button to put it on a NEW invoice, billing the GC twice.
      invoiced_invoice_id: mapped("invoice", w.Id),
    }, r);
    // The internal version of the story, kept off the customer's document.
    if (COMMIT) {
      await remember("change_order", w.Id, mapped("change_order", w.Id),
        residual
          ? `Salesforce tracks change-order VALUE per job, not individual change orders. This row is that total, plus $${(residual / 100).toFixed(2)} the job's balance owed carries beyond its invoice — work that was billed but never written down as a change order.`
          : "Salesforce tracks change-order VALUE per job, not individual change orders. This row is that total, so the contract matches.");
    }
  }
  return r;
}

async function stageInvoices() {
  const r = newReport("invoices");
  for (const w of SF.wos) {
    const dealId = mapped("deal", w.Opportunity__c);
    // A work order does not always carry the GC; the opportunity always does.
    const accountId = mapped("account", w.AccountId) ?? mapped("account", SF.opps.find((o) => o.Id === w.Opportunity__c)?.AccountId);
    if (!dealId || !accountId) { r.skipped.push(`${w.WorkOrderNumber}: deal or account missing`); continue; }
    const plan = planInvoice({
      quotedSubtotalWithCo: w.Quoted_Subtotal_with_Change_Order__c,
      totalChangeOrder: w.TotalChangeOrder__c,
      tax: w.Tax,
      grandTotal: w.GrandTotal__c,
      totalPaymentsIn: w.TotalPaymentsIn__c,
      balanceOwed: w.BalanceOwed__c,
    });
    const cols = planInvoiceColumns(plan);
    if (cols.taxFolded) r.skipped.push(`${w.WorkOrderNumber}: tax folded into the subtotal (no 3-dp rate reproduced it exactly)`);
    const note = adjustmentLabel(plan);
    const invoiceId = await put("invoice", w.Id, "commercial_invoices", {
      opportunity_id: dealId,
      account_id: accountId,
      invoice_number: `SF-${w.WorkOrderNumber}`,
      status: invoiceStatus(plan),
      subtotal_cents: cols.subtotal_cents,
      tax_pct: cols.tax_pct,
      issued_at: at(ymd(w.StartDate) ?? ymd(w.CreatedDate)),
      // Set BEFORE payments land: the payment trigger stamps paid_at with now()
      // when it is null, which would date every historical job today.
      paid_at: plan.balanceCents <= 0 ? at(ymd(w.EndDate) ?? ymd(w.StartDate) ?? ymd(w.CreatedDate)) : null,
      po_number: w.Customer_PO__c || null,
      payment_terms: w.Payment_Terms__c || null,
      // THE DUE DATE, from the terms Salesforce holds on the job.
      //
      // Left NULL until 2026-09-16 on purpose: a due date arms the daily
      // past-due email, and nobody wanted that pointed at Tomco's 75 GCs before
      // they had used the platform. Karan turned the reminder off (see
      // DUNNING_ENABLED in lib/commercial/cron/invoice-dunning.ts) and asked for
      // the dates, so AR aging can do the one thing it is for.
      due_at: at(dueDateFor(ymd(w.StartDate) ?? ymd(w.CreatedDate), w.Payment_Terms__c)),
      notes: [`Imported from Salesforce work order ${w.WorkOrderNumber}.`, note].filter(Boolean).join(" "),
    }, r);
    // The adjustment used to also be written as an invoice LINE ITEM here. It
    // never once succeeded, and never said so:
    //   · `onConflict: "invoice_id,position"` names no unique constraint —
    //     (invoice_id, position) carries only a plain index — so Postgres
    //     answered 42P10, whose message contains the word "conflict", which the
    //     error filter treated as a harmless duplicate and swallowed.
    //   · and four of the seven adjustments are NEGATIVE, which the table
    //     rejects outright unless the line belongs to a change order.
    // It is not worth resurrecting: `subtotal_cents` is stored, not summed from
    // the lines, so a single -$21.75 line under a $1,087.50 subtotal would read
    // as an invoice that does not add up. The explanation is on the invoice in
    // `notes` above — verified present on all 7 — and that is where it belongs.
  }
  return r;
}

async function stagePayments() {
  const r = newReport("payments");
  for (const t of SF.txInScope) {
    if ((t.RecordType?.DeveloperName ?? "") !== "Payment_In") continue;
    const invoiceId = mapped("invoice", t.WorkOrder__c);
    if (!invoiceId) { r.skipped.push(`payment ${t.Name}: no invoice for its work order`); continue; }
    await put("payment", t.Id, "commercial_invoice_payments", {
      invoice_id: invoiceId,
      amount_cents: cents(t.Amount__c),
      paid_at: at(ymd(t.Date__c) ?? ymd(t.CreatedDate)),
      method: (t.Method__c || "other").toLowerCase().includes("check") ? "check" : (t.Method__c || "other").toLowerCase().includes("ach") || (t.Method__c || "").toLowerCase().includes("wire") ? "ach" : "other",
      reference: t.ReferenceId__c || t.Name || null,
      notes: "Imported from Salesforce",
      deposited_at: t.Deposited__c ? at(ymd(t.Date__c)) : null,
    }, r);
  }
  // Writing a payment fires the invoice's recompute trigger, which moves
  // `commercial_invoices.updated_at`. Left alone, the next run would read every
  // one of those invoices as edited-by-a-person and refuse Salesforce's updates
  // — the guard protecting the rows from the importer itself.
  const restamped = await restampEntity("invoice");
  if (restamped) r.notes.push(`re-stamped ${restamped} invoice(s) the payment trigger touched`);
  return r;
}

async function stageCosts() {
  const r = newReport("costs");
  for (const t of SF.txInScope) {
    const kind = { recordType: t.RecordType?.DeveloperName ?? null, payeeType: t.PayeeType__c ?? null };
    const category = purchaseCategory(kind);
    if (!category) continue; // payments in are money, not cost
    const dealId = mapped("deal", t.Opportunity__c) ?? (t.WorkOrder__c ? mapped("deal", SF.wos.find((w) => w.Id === t.WorkOrder__c)?.Opportunity__c) : null);
    if (!dealId) { r.skipped.push(`${category} ${t.Name}: no imported deal`); continue; }
    const vendorSfId = t.RetailVendor__c || t.Payee__c;
    const vendor = await vendorBySfId(vendorSfId);
    const accountId = mapped("account", SF.wos.find((w) => w.Id === t.WorkOrder__c)?.AccountId);
    await put("purchase", t.Id, "commercial_project_purchases", {
      opportunity_id: dealId,
      account_id: accountId,
      category,
      vendor: vendor?.name ?? t.RetailVendor__r?.Name ?? t.Payee__r?.Name ?? null,
      vendor_id: vendor?.id ?? null,
      amount_cents: cents(t.Amount__c),
      purchased_at: at(ymd(t.Date__c)),
      description: t.Description__c || t.Name || null,
      reimburse_to: isReimbursement(kind) ? (t.Payee__r?.Name ?? null) : null,
      reimbursed_at: isReimbursement(kind) ? at(ymd(t.Date__c)) : null,
    }, r);
  }
  return r;
}

/**
 * Who a row of attendance belongs to.
 *
 * 919 of the 1,919 rows name a worker ("Miguel Melgar"). The other 1,000 —
 * 7,790 hours, more than half — name only the crew company they came through
 * ("Tomco Labor - Miguel"). Salesforce records them that way, so the hours land
 * where Salesforce put them rather than being guessed onto a person: "Rob"
 * could be Robert Caputo or Robert Patterson, and attributing a man's hours to
 * the wrong man is worse than an extra row in a list Katie can merge.
 */
function attendanceWho(a) {
  const worker = (a.Crew_Worker__c ?? "").trim();
  if (worker) return { key: `crew:${worker}`, name: worker, viaCompany: false };
  const company = (a.Crew__r?.Name ?? "").trim();
  if (company) return { key: `crewco:${company}`, name: company, viaCompany: true };
  return null;
}

async function stageEmployees() {
  const r = newReport("employees");
  const people = new Map();
  for (const a of SF.attendanceInScope) {
    const who = attendanceWho(a);
    if (who) people.set(who.key, who);
  }
  for (const [, who] of people) {
    await put("employee", who.key, "commercial_employees", {
      ...employeeFromCrewWorker(who.name),
      external_ref: `sf-${who.key}`,
      active: true,
    }, r);
  }
  return r;
}

/**
 * Brendan's crews, as crews — not just as a label on old attendance.
 *
 * Salesforce is being retired, so the platform has to BE the record: the crews
 * he already works with need to exist here, ready to schedule, with the right
 * people in them. Every membership below is one Salesforce recorded itself, on
 * an attendance row naming both the crew and the worker — nothing is inferred
 * from a name.
 *
 * The foreman is the person who appears on that crew most often. That IS a
 * judgement, so it is one click to change and the crew works either way.
 */
async function stageCrews() {
  const r = newReport("crews");
  const pairCounts = new Map(); // company -> Map(workerKey -> rows)
  const companies = new Map();  // company name -> nothing, just the set
  for (const a of SF.attendanceInScope) {
    const company = (a.Crew__r?.Name ?? "").trim();
    if (!company) continue;
    companies.set(company, true);
    const worker = (a.Crew_Worker__c ?? "").trim();
    if (!worker) continue;
    if (!pairCounts.has(company)) pairCounts.set(company, new Map());
    const m = pairCounts.get(company);
    m.set(worker, (m.get(worker) ?? 0) + 1);
  }

  for (const company of companies.keys()) {
    const members = [...(pairCounts.get(company) ?? new Map()).entries()].sort((a, b) => b[1] - a[1]);
    // The crew company itself imported as an employee (it carries the hours
    // Salesforce never attributed to a person); the foreman is the named worker
    // seen most on this crew, if there is one.
    const foremanKey = members[0]?.[0] ? `crew:${members[0][0]}` : `crewco:${company}`;
    const crewId = await put("crew", `crewco:${company}`, "commercial_crews", {
      name: company,
      foreman_employee_id: mapped("employee", foremanKey),
      active: true,
    }, r);
    if (!crewId) continue;
    for (const [worker] of members) {
      const employeeId = mapped("employee", `crew:${worker}`);
      if (!employeeId) { r.skipped.push(`${company}: ${worker} has no employee record`); continue; }
      await put("crew_member", `crewco:${company}|crew:${worker}`, "commercial_crew_members", {
        crew_id: crewId,
        employee_id: employeeId,
      }, r);
    }
    // The company-as-employee belongs to its own crew too, so the hours
    // Salesforce recorded against the company sit inside the crew that did them.
    const companyEmployee = mapped("employee", `crewco:${company}`);
    if (companyEmployee) {
      await put("crew_member", `crewco:${company}|self`, "commercial_crew_members", {
        crew_id: crewId,
        employee_id: companyEmployee,
      }, r);
    }
  }
  return r;
}

/**
 * Salesforce's attendance rows → one day per person per job, which is what the
 * platform stores.
 *
 * Lives outside the stage because the reconciliation needs the SAME fold: to
 * say whether the hours on screen are right it has to compare like with like,
 * and a second, separately-written copy of this arithmetic would only ever
 * agree with the first by luck.
 *
 * `note` is called for anything worth saying out loud; the stage turns those
 * into skips, the reconciliation ignores them.
 */
function foldAttendanceDays(note = () => {}) {
  const byDay = new Map();
  for (const a of SF.attendanceInScope) {
    const who = attendanceWho(a);
    // One row carries 8 hours with no dates at all (Tomco Labor - JJ on AIREF
    // #2). Salesforce is being retired, so dropping real hours is worse than
    // dating them by the day the row was created — flagged, not hidden.
    const dated = ymd(a.StartDate__c) ?? ymd(a.EndDate__c);
    const workDate = dated ?? ymd(a.CreatedDate);
    if (!dated && workDate) note(`attendance ${a.Id}: no work date in Salesforce — dated ${workDate}, the day the row was created (${a.Hours_Worked__c ?? 0}h)`);
    if (!who || !workDate) {
      note(`attendance ${a.Id}: ${!who ? "no employee" : "no date at all"}`);
      continue;
    }
    const key = `attday:${a.WorkOrder__c}|${who.key}|${workDate}`;
    const hours = Number(a.Hours_Worked__c ?? 0);
    const prev = byDay.get(key);
    if (prev) prev.hours += hours;
    else byDay.set(key, { woId: a.WorkOrder__c, whoKey: who.key, workDate, hours });
  }
  return byDay;
}

/** What the day's hours become in a numeric(4,2) column. */
const storedHours = (h) => Math.max(0, Math.min(99.99, Math.round(h * 100) / 100));

async function stageAttendance() {
  const r = newReport("attendance");
  // Attendance needs a Field Ops job per deal to hang off.
  const jobForDeal = new Map();
  for (const w of SF.wos) {
    const dealId = mapped("deal", w.Opportunity__c);
    if (!dealId) continue;
    const jobId = await put("job", w.Id, "commercial_jobs", {
      job_code: `SF-${w.WorkOrderNumber}`,
      name: (w.Name__c || w.WorkOrderNumber || "Job").slice(0, 160),
      opportunity_id: dealId,
      account_id: mapped("account", w.AccountId),
      customer_name: w.Account?.Name ?? null,
      site_address: w.Street || null,
      site_city: w.City || null,
      site_state: w.State || null,
      site_zip: w.PostalCode || null,
      // Salesforce's status, not a constant. Every job came across as `closed`,
      // and Field Ops shows only open ones — so the calendar, the Jobs page and
      // the overview KPIs were empty on jobs Brendan's crews were working that
      // day, and he could not schedule anyone onto one without editing it first.
      status: jobStatusForWorkOrder(w.Status),
      // The work order this job IS. Without it, the Jobs page's
      // `ensureWorkOrdersForConnectedJobs` sees a job with a deal and no work
      // order and mints a second, empty one on first load.
      work_order_id: mapped("work_order", w.Id),
      target_start: ymd(w.StartDate),
      target_end: ymd(w.EndDate),
    }, r);
    jobForDeal.set(w.Id, jobId);
  }
  // One entry per person per job per day — the table enforces it with a UNIQUE
  // on (employee, job, work_date). Salesforce has 29 cases of the same person
  // on the same job twice in a day, so those FOLD: the hours are summed and the
  // day's total is what it always was. No Salesforce row spans more than one
  // day, so nothing needs spreading across dates.
  const byDay = foldAttendanceDays((m) => r.skipped.push(m));

  // The hours ledger, stated out loud. Salesforce's total, what the fold keeps,
  // and what actually gets stored have to be the same number — if they are not,
  // this says WHERE the hours went rather than leaving the reconciliation to
  // report a gap with no explanation.
  const sfIn = SF.attendanceInScope.reduce((n, a) => n + Number(a.Hours_Worked__c ?? 0), 0);
  let folded = 0;
  for (const [, d] of byDay) folded += d.hours;
  let stored = 0;

  for (const [key, day] of byDay) {
    const jobId = jobForDeal.get(day.woId);
    const employeeId = mapped("employee", day.whoKey);
    if (!jobId || !employeeId) {
      r.skipped.push(`${key}: ${!jobId ? "no job" : "no employee"} (${day.hours}h)`);
      continue;
    }
    const rounded = Math.round(day.hours * 100) / 100;
    // numeric(4,2) holds 99.99. Capping at 24 would look tidy and silently drop
    // hours that the reconciliation would then report as missing.
    const hours = storedHours(day.hours);
    if (hours !== rounded) r.skipped.push(`${key}: ${rounded}h is more than the column holds; stored ${hours}`);
    await put("attendance", key, "commercial_time_entries", {
      job_id: jobId,
      employee_id: employeeId,
      work_date: day.workDate,
      actual_hours: hours,
      source: "manual",
      status: "approved",
      created_at: `${day.workDate}T12:00:00Z`,
    }, r);
    stored += hours;
  }
  const fmt = (n) => n.toFixed(2);
  r.notes.push(`hours: Salesforce ${fmt(sfIn)} → folded ${fmt(folded)} → stored ${fmt(stored)}`);
  if (Math.abs(sfIn - stored) >= 0.01) {
    r.notes.push(`⚠️  ${fmt(sfIn - stored)}h did not make it across — see the skipped list above.`);
  }
  return r;
}

/**
 * What kind of document this is, from its name. Tomco's own naming is the only
 * signal Salesforce gives, so this is a best guess with a safe fallback — every
 * file lands on the deal either way, and "other" is a filter, not a loss.
 */
export function documentCategory(title) {
  // Match the NORMALISED name, not the raw title. Sherwin Williams receipts are
  // titled "Sale#PA343844" in Salesforce and my rule looked for "Sale-…" —
  // which is what the file is CALLED here, after sanitising. Tested against my
  // own invented example, it passed; against the real data, 540 files stayed
  // filed as "other".
  const t = (title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  if (/(^|-)(quote|proposal|estimate|bid)(-|$)/.test(t)) return "proposal";
  if (/(^|-)(plans?|drawings?|specs?|bid-set|permit-set|stamped)(-|$)/.test(t)) return "bid_set";
  if (/(^|-)(invoices?|billing|application-for-payment|aia|g70\d?)(-|$)/.test(t)) return "invoice_attachment";
  if (/(^|-)(coi|certificate-of-insurance|insurance)(-|$)/.test(t)) return "insurance";
  if (/(^|-)w-?9(-|$)/.test(t)) return "w9";
  if (/(^|-)(lien|waiver)(-|$)/.test(t)) return "lien_waiver";
  if (/(^|-)(change-order|co-?\d+)(-|$)/.test(t)) return "change_order";
  if (/(^|-)(photos?|image|screenshot)(-|$)/.test(t)) return "site_photo";
  if (/(^|-)(contracts?|agreement|signed)(-|$)/.test(t)) return "contract";
  if (/(^|-)(submittals?|product-data|drawdown)(-|$)/.test(t)) return "submittal";
  if (/(^|-)(closeout|as-?built|o-m|warranty)(-|$)/.test(t)) return "closeout";
  // Tomco's receipts, by the names their sources give them: Sherwin Williams
  // ("Sale-PA343844"), Aboffs ("aboffs_JHSB7"), and the office scanner, which
  // names a file after the moment it was scanned ("2025-09-24-14-42",
  // "img20251106_09320170"). 776 of the 890 files landed in "other" before
  // this, which is honest but useless as a filter.
  if (/^sale-?\w+/.test(t)) return "receipt";
  if (/^(aboffs|sherwin|home ?depot|lowes|ace|amazon)/.test(t)) return "receipt";
  if (/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}/.test(t)) return "receipt";
  if (/^img\d{6,}/.test(t)) return "receipt";
  return "other";
}

const MIME = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel", csv: "text/csv", txt: "text/plain" };

function safeName(name) {
  return (name ?? "file").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 120) || "file";
}

/**
 * The 893 files attached to Tomco's jobs — plans, signed contracts, photos,
 * the quote PDFs. 328 MB, so this is the slow stage: it runs last, one file at
 * a time, and skips anything already imported, which makes a failure halfway
 * through cost only the files it had not reached.
 */
async function stageFiles() {
  const r = newReport("files");
  // One document can be linked to both the opportunity and its work order;
  // import it ONCE, against the deal.
  const dealForDoc = new Map();
  for (const l of SF.links) {
    if (dealForDoc.has(l.ContentDocumentId)) continue;
    const viaOpp = mapped("deal", l.LinkedEntityId);
    const wo = SF.wos.find((w) => w.Id === l.LinkedEntityId);
    const dealId = viaOpp ?? (wo ? mapped("deal", wo.Opportunity__c) : null);
    if (dealId) dealForDoc.set(l.ContentDocumentId, dealId);
  }

  let done = 0;
  for (const doc of SF.docs) {
    const dealId = dealForDoc.get(doc.Id);
    if (!dealId) { r.skipped.push(`${doc.Title}: not attached to an imported deal`); continue; }
    const already = mapped("file", doc.Id);
    if (already) {
      // Already imported: do not download it again, but DO refresh the
      // classification, so improving the rules re-files the old import.
      r.total += 1;
      r.updated += 1;
      if (COMMIT) {
        const { error } = await sb.from("commercial_documents").update({ category: documentCategory(doc.Title) }).eq("id", already);
        if (error) r.skipped.push(`${doc.Title}: re-file failed — ${error.message}`);
      }
      continue;
    }
    const ext = (doc.FileExtension ?? "").toLowerCase();
    const mime = MIME[ext] ?? "application/octet-stream";
    const fileName = `${safeName(doc.Title)}${ext ? `.${ext}` : ""}`;
    const category = documentCategory(doc.Title);
    const size = Number(doc.ContentSize ?? 0);

    if (!COMMIT) {
      r.total += 1; r.would += 1;
      if (r.sample.length < 3) r.sample.push({ fileName, category, mb: +(size / 1024 / 1024).toFixed(2) });
      continue;
    }

    // Pull the bytes from Salesforce, then put them in Storage, then record the
    // row — in that order, so a row never points at a file that is not there.
    let bytes;
    try {
      const res = await fetch(`${conn.instanceUrl}/services/data/v60.0/sobjects/ContentVersion/${doc.LatestPublishedVersionId}/VersionData`, {
        headers: { Authorization: `Bearer ${conn.accessToken}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      bytes = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      r.skipped.push(`${doc.Title}: download failed — ${err instanceof Error ? err.message : err}`);
      continue;
    }

    const documentId = crypto.randomUUID();
    const storageKey = `opportunitys/${dealId}/${documentId}-${fileName}`;
    const up = await sb.storage.from("commercial-documents").upload(storageKey, bytes, { contentType: mime, upsert: true });
    if (up.error) { r.skipped.push(`${doc.Title}: upload failed — ${up.error.message}`); continue; }

    const { error } = await sb.from("commercial_documents").insert({
      id: documentId,
      parent_type: "opportunity",
      parent_id: dealId,
      category,
      file_name: fileName,
      storage_key: storageKey,
      size_bytes: bytes.byteLength,
      mime_type: mime,
      version: 1,
      status: "approved",
      notes: `Imported from Salesforce (${doc.Title})`,
      uploaded_at: new Date().toISOString(),
    });
    if (error) {
      await sb.storage.from("commercial-documents").remove([storageKey]).catch(() => {});
      r.skipped.push(`${doc.Title}: row insert failed — ${error.message}`);
      continue;
    }
    await remember("file", doc.Id, documentId);
    r.total += 1; r.inserted += 1;
    done += 1;
    if (done % 50 === 0) console.log(`   …${done} files`);
  }

  // THE RECEIPT, ON THE COST IT PAYS FOR.
  //
  // Salesforce links each receipt to its Transaction as well as to the job, so
  // the pairing is recorded and does not have to be guessed from an amount or a
  // date. Without this the 730 receipts land as one flat list on the deal and
  // every cost line reads "no receipt", which is the opposite of what Tomco
  // has: a photographed receipt for nearly every purchase.
  //
  // A document can be linked to several transactions (one receipt covering a
  // few lines), and a purchase holds one receipt — so the first wins and the
  // rest stay reachable in Documents.
  let linked = 0;
  const seenPurchase = new Set();
  for (const l of SF.txLinks ?? []) {
    const documentId = mapped("file", l.ContentDocumentId);
    const purchaseId = mapped("purchase", l.LinkedEntityId);
    if (!documentId || !purchaseId || seenPurchase.has(purchaseId)) continue;
    seenPurchase.add(purchaseId);
    if (!COMMIT) { linked += 1; continue; }
    const { error } = await sb
      .from("commercial_project_purchases")
      .update({ receipt_document_id: documentId })
      .eq("id", purchaseId)
      .is("receipt_document_id", null); // never overwrite one somebody attached
    if (error) { r.skipped.push(`receipt link for purchase ${purchaseId}: ${error.message}`); continue; }
    linked += 1;
  }
  r.notes.push(`receipts attached to their cost line: ${linked}`);
  return r;
}

/**
 * Put the history back on the rows.
 *
 * Every imported row got `created_at = now()`, because that is the column
 * default — so the dashboard's revenue chart, which buckets invoices by
 * created_at, showed Tomco's entire $2.7M as billed THIS MONTH. Anything that
 * asks "what happened lately" had the same answer: all of it, today.
 *
 * Cash flow was unaffected — it reads issued_at and paid_at, which were right
 * from the start. That is the difference between a report reading the date the
 * thing HAPPENED and the date the row was written.
 */
async function stageDates() {
  const r = newReport("dates");
  const woById = new Map(SF.wos.map((w) => [w.Id, w]));
  const txById = new Map(SF.tx.map((t) => [t.Id, t]));
  const oppById = new Map(SF.opps.map((o) => [o.Id, o]));
  const docById = new Map(SF.docs.map((d) => [d.Id, d]));

  // entity -> [table, how to find its historical date]
  const SOURCES = {
    account: ["commercial_accounts", (sfId) => SF.accounts.find((a) => a.Id === sfId)?.CreatedDate],
    contact: ["commercial_contacts", (sfId) => SF.contacts.find((c) => c.Id === sfId)?.CreatedDate],
    deal: ["commercial_opportunities", (sfId) => oppById.get(sfId)?.CreatedDate],
    work_order: ["commercial_work_orders", (sfId) => woById.get(sfId)?.CreatedDate],
    job: ["commercial_jobs", (sfId) => woById.get(sfId)?.CreatedDate],
    change_order: ["commercial_change_orders", (sfId) => woById.get(sfId)?.StartDate ?? woById.get(sfId)?.CreatedDate],
    invoice: ["commercial_invoices", (sfId) => woById.get(sfId)?.StartDate ?? woById.get(sfId)?.CreatedDate],
    payment: ["commercial_invoice_payments", (sfId) => txById.get(sfId)?.Date__c],
    purchase: ["commercial_project_purchases", (sfId) => txById.get(sfId)?.Date__c],
    file: ["commercial_documents", (sfId) => docById.get(sfId)?.CreatedDate],
  };

  for (const [entity, [table, dateFor]] of Object.entries(SOURCES)) {
    for (const [key, rowId] of MAP) {
      if (!key.startsWith(`${entity}:`)) continue;
      const sfId = key.slice(entity.length + 1);
      const when = dateFor(sfId);
      const iso = when ? (String(when).length === 10 ? `${when}T12:00:00Z` : String(when)) : null;
      if (!iso) { r.skipped.push(`${entity} ${sfId}: no date in Salesforce`); continue; }
      r.total += 1;
      if (!COMMIT) { r.would += 1; if (r.sample.length < 3) r.sample.push({ table, rowId, created_at: iso }); continue; }
      const patch = { created_at: iso };
      if (table === "commercial_documents") patch.uploaded_at = iso;
      const { error } = await sb.from(table).update(patch).eq("id", rowId);
      if (error) { r.skipped.push(`${table} ${rowId}: ${error.message}`); continue; }
      r.updated += 1;
    }
  }
  return r;
}

/**
 * The project record every won job needs.
 *
 * The platform hangs a job's delivery off a project: invoices, costs, change
 * orders and work orders all carry a project_id, filled by a trigger AT INSERT
 * from the deal — if the project exists. It did not, so 92 jobs each said "This
 * job has no project record. Its invoices, change orders and costs have nothing
 * to hang off." and every project_id is null.
 *
 * So: create the project, then backfill the links the trigger could not.
 */
async function stageProjects() {
  const r = newReport("projects");
  const PROJECT_STATUS = {
    post_sale_closed: "closed_out",
    billing: "billing",
    in_progress: "in_progress",
    pre_construction: "pre_construction",
  };
  for (const w of SF.wos) {
    const dealId = mapped("deal", w.Opportunity__c);
    if (!dealId) { r.skipped.push(`${w.WorkOrderNumber}: no deal`); continue; }
    const st = dealStatusForWorkOrder(w.Status);
    const { data: deal } = COMMIT
      ? await sb.from("commercial_opportunities").select("project_number, title").eq("id", dealId).maybeSingle()
      : { data: null };
    const projectId = await put("project", w.Id, "commercial_projects", {
      opportunity_id: dealId,
      project_number: deal?.project_number ?? null,
      name: (w.Name__c || deal?.title || w.WorkOrderNumber || "Project").slice(0, 200),
      contract_base_cents: cents(w.Quoted_Subtotal_with_Change_Order__c),
      contract_source: "accepted_snapshot",
      status: PROJECT_STATUS[st.status] ?? "awarded",
      started_at: ymd(w.StartDate),
      substantially_complete_at: isClosedWorkOrder(w.Status) ? ymd(w.EndDate) : null,
      closed_out_at: st.status === "post_sale_closed" ? (ymd(w.EndDate) ?? ymd(w.StartDate)) : null,
      created_at: w.CreatedDate,
    }, r);
    if (!COMMIT || !projectId) continue;
    // The trigger fills project_id at INSERT, and these rows were inserted
    // before any project existed. Link them now, or the Project tab, the job
    // report and the money rollups all read empty.
    for (const table of ["commercial_invoices", "commercial_change_orders", "commercial_project_purchases", "commercial_work_orders", "commercial_jobs"]) {
      const { error } = await sb.from(table).update({ project_id: projectId }).eq("opportunity_id", dealId).is("project_id", null);
      if (error) r.skipped.push(`${table} link for ${w.WorkOrderNumber}: ${error.message}`);
    }
  }
  return r;
}

const RUNNERS = {
  accounts: stageAccounts, contacts: stageContacts, deals: stageDeals, jobs: stageJobs,
  "change-orders": stageChangeOrders, invoices: stageInvoices, payments: stagePayments,
  costs: stageCosts, employees: stageEmployees, crews: stageCrews, attendance: stageAttendance,
  projects: stageProjects, files: stageFiles, dates: stageDates,
};

// ─── reconcile ──────────────────────────────────────────────────────────────

/** Every row, not the first thousand. Ordered by id so pagination is stable. */
async function readAll(table, columns, shape = (q) => q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await shape(sb.from(table).select(columns).order("id", { ascending: true }).range(from, from + 999));
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function reconcile() {
  const problems = [];
  const money = (c) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

  let sfContract = 0, sfBalance = 0, sfPaid = 0, ourContract = 0, ourBalance = 0, ourPaid = 0;
  for (const w of SF.wos) {
    const dealId = mapped("deal", w.Opportunity__c);
    if (!dealId) { problems.push(`${w.WorkOrderNumber}: no deal imported`); continue; }
    const { data: inv } = await sb
      .from("commercial_invoices")
      .select("subtotal_cents, total_cents, paid_cents, balance_cents")
      .eq("opportunity_id", dealId)
      .is("deleted_at", null);
    const ourTotal = (inv ?? []).reduce((n, i) => n + Number(i.subtotal_cents), 0);
    const ourPaidJob = (inv ?? []).reduce((n, i) => n + Number(i.paid_cents), 0);
    const ourBalanceJob = (inv ?? []).reduce((n, i) => n + Number(i.balance_cents), 0);
    const sfBalanceJob = cents(w.BalanceOwed__c);
    const sfPaidJob = cents(w.TotalPaymentsIn__c);

    if (ourBalanceJob !== sfBalanceJob) problems.push(`${w.WorkOrderNumber} balance: ours ${money(ourBalanceJob)} vs Salesforce ${money(sfBalanceJob)}`);
    if (ourPaidJob !== sfPaidJob) problems.push(`${w.WorkOrderNumber} collected: ours ${money(ourPaidJob)} vs Salesforce ${money(sfPaidJob)}`);

    sfContract += cents(w.Quoted_Subtotal_with_Change_Order__c);
    sfBalance += sfBalanceJob;
    sfPaid += sfPaidJob;
    ourContract += ourTotal;
    ourBalance += ourBalanceJob;
    ourPaid += ourPaidJob;
  }

  const { count: deals } = await sb.from("commercial_opportunities").select("id", { count: "exact", head: true }).is("deleted_at", null);
  const { count: accounts } = await sb.from("commercial_accounts").select("id", { count: "exact", head: true }).is("deleted_at", null);
  // PAGINATED. PostgREST caps a response at 1000 rows, so the first version of
  // this read 1000 of 1,626 purchases and reported materials at 61% of thetrue
  // figure — a reconciliation that INVENTED a discrepancy in correctly imported
  // data. The check has to be at least as careful as the thing it checks.
  const purch = await readAll("commercial_project_purchases", "category, amount_cents", (q) => q.is("deleted_at", null));
  const ourMaterials = purch.filter((p) => p.category === "materials").reduce((n, p) => n + Number(p.amount_cents), 0);
  const ourLabor = purch.filter((p) => p.category === "labor").reduce((n, p) => n + Number(p.amount_cents), 0);
  // AS OF THE LAST IMPORT, for the same reason the hours are (below): Tomco is
  // entering crew payments in Salesforce while we look at it — the labor total
  // moved three times in one afternoon. A transaction with no row in the import
  // map has not been brought across yet, which is work to do at cutover and not
  // a discrepancy. Same map-based test as attendance: no timestamp guessing.
  const notYetImported = (t) => !mapped("purchase", t.Id) && !mapped("payment", t.Id);
  const arrivedSince = SF.txInScope.filter(notYetImported);
  const inScopeAtImport = SF.txInScope.filter((t) => !notYetImported(t));
  const sumOf = (list, pick) => list.filter(pick).reduce((n, t) => n + cents(t.Amount__c), 0);
  const isPurchase = (t) => t.RecordType?.DeveloperName === "Purchase";
  const isLabor = (t) => t.RecordType?.DeveloperName === "Payment_Out" && t.PayeeType__c === "Labor_Company";
  const sfMaterials = sumOf(inScopeAtImport, isPurchase);
  const sfLabor = sumOf(inScopeAtImport, isLabor);
  const sinceMaterials = sumOf(arrivedSince, isPurchase);
  const sinceLabor = sumOf(arrivedSince, isLabor);
  const hoursRows = await readAll("commercial_time_entries", "id, actual_hours");
  const ourHours = hoursRows.reduce((n, h) => n + Number(h.actual_hours), 0);
  const sfHours = SF.attendanceInScope.reduce((n, a) => n + Number(a.Hours_Worked__c ?? 0), 0);

  const rows = [
    ["collected", ourPaid, sfPaid],
    ["outstanding", ourBalance, sfBalance],
    ["materials", ourMaterials, sfMaterials],
    ["labor payouts", ourLabor, sfLabor],
  ];
  console.log("\n            what            ours              Salesforce        ");
  for (const [label, ours, theirs] of rows) {
    const ok = ours === theirs;
    if (!ok) problems.push(`TOTAL ${label}: ours ${money(ours)} vs Salesforce ${money(theirs)}`);
    console.log(`  ${ok ? "✅" : "❌"} ${label.padEnd(16)} ${money(ours).padStart(16)}  ${money(theirs).padStart(16)}`);
  }
  if (arrivedSince.length) {
    console.log(`     ↳ ${arrivedSince.length} transaction(s) entered in Salesforce since the import` +
      `${sinceMaterials ? ` · materials +${money(sinceMaterials)}` : ""}` +
      `${sinceLabor ? ` · labor +${money(sinceLabor)}` : ""}.`);
    console.log(`       Not a discrepancy — Tomco is still working. Re-run \`--stage=costs,payments --commit\` at cutover.`);
  }

  // Salesforce is STILL LIVE. Tomco's crews clock in there every working day —
  // 14 new rows appeared inside one five-minute import run on 2026-09-16 — so
  // the hours total moves while we are looking at it. Counting that as a
  // discrepancy would mean this check could never read green until Salesforce
  // is switched off.
  //
  // Comparing by timestamp cannot separate "logged since" from "we lost it":
  // the Salesforce snapshot is taken once at the start of a run, so rows
  // created DURING it are missing from the import without being newer than it.
  // So this compares the actual work instead. The fold is re-run from the same
  // function the import uses, and every day is looked up through the map:
  //   · no mapped row            → new work, not imported yet
  //   · mapped, different hours  → edited in Salesforce since
  //   · mapped, hours match      → correct
  // What is left after those three is a real discrepancy, and it still fails.
  const fold = foldAttendanceDays();
  const byRow = new Map(hoursRows.map((h) => [h.id, Number(h.actual_hours)]));
  const accountedRows = new Set();
  let pendingNew = 0, pendingNewDays = 0, changed = 0, changedDays = 0, capped = 0;
  for (const [key, day] of fold) {
    const want = storedHours(day.hours);
    const rowId = mapped("attendance", key);
    const have = rowId ? byRow.get(rowId) : undefined;
    if (rowId) accountedRows.add(rowId);
    if (have === undefined) { pendingNew += want; pendingNewDays++; }
    else if (Math.abs(want - have) >= 0.005) { changed += want - have; changedDays++; }
    // numeric(4,2) tops out at 99.99; a day longer than that loses hours for
    // real, and that is OURS, not Salesforce moving.
    const rounded = Math.round(day.hours * 100) / 100;
    if (rounded > want) capped += rounded - want;
  }
  const orphans = hoursRows.filter((h) => !accountedRows.has(h.id));
  const orphanHours = orphans.reduce((n, h) => n + Number(h.actual_hours), 0);

  const explained = ourHours + pendingNew + changed + capped - orphanHours;
  const hoursOk = Math.abs(explained - sfHours) < 0.01 && capped < 0.01 && orphans.length === 0;
  if (!hoursOk) {
    problems.push(`TOTAL hours: ours ${ourHours.toFixed(2)} + ${(pendingNew + changed).toFixed(2)} not yet re-imported vs Salesforce ${sfHours.toFixed(2)}`);
  }
  console.log(`  ${hoursOk ? "✅" : "❌"} ${"attendance hours".padEnd(16)} ${ourHours.toFixed(1).padStart(16)}  ${sfHours.toFixed(1).padStart(16)}`);
  if (pendingNewDays || changedDays) {
    const bits = [];
    if (pendingNewDays) bits.push(`${pendingNewDays} new day(s) (+${pendingNew.toFixed(1)}h)`);
    if (changedDays) bits.push(`${changedDays} edited day(s) (${changed >= 0 ? "+" : ""}${changed.toFixed(1)}h)`);
    console.log(`     ↳ ${bits.join(" · ")} logged in Salesforce since the import.`);
    console.log(`       Not a discrepancy — Tomco is still working. Re-run \`--stage=attendance --commit\` at cutover.`);
  }
  if (capped >= 0.01) console.log(`     ❌ ${capped.toFixed(2)}h lost to the numeric(4,2) column cap.`);
  if (orphans.length) console.log(`     ❌ ${orphans.length} time entr(ies) (${orphanHours.toFixed(1)}h) here with no Salesforce row behind them.`);
  // Our subtotal carries the adjustments that make the seven jobs match
  // Salesforce's balance, so it is EXPECTED to differ from Salesforce's quoted
  // subtotal by exactly those adjustments. Say so rather than printing two
  // numbers and leaving it hanging.
  const adjustments = ourContract - sfContract;
  console.log(`\n  deals ${deals} · accounts ${accounts}`);
  console.log(`  contract: ours ${money(ourContract)} vs Salesforce ${money(sfContract)}${adjustments ? `  (difference ${money(adjustments)} = the carried-over adjustments)` : ""}`);
  if (SF.txOutOfScope.length) {
    const amt = SF.txOutOfScope.reduce((n, t) => n + cents(t.Amount__c), 0);
    console.log(`  (excluded on purpose: ${SF.txOutOfScope.length} transaction(s) ${money(amt)} on canceled work orders)`);
  }

  if (problems.length) {
    console.log(`\n❌ ${problems.length} difference(s):`);
    for (const p of problems.slice(0, 40)) console.log(`   ${p}`);
    if (problems.length > 40) console.log(`   …and ${problems.length - 40} more`);
    process.exit(1);
  }
  console.log("\n✅ every figure matches Salesforce to the cent");
}

/**
 * Say "what is here now is what we last wrote", for every mapped row.
 *
 * Writes no data — only `commercial_import_map.updated_at`. Run it once when
 * the two systems agree, and again at cutover, so the platform-wins guard has
 * an honest starting point.
 */
const ENTITY_TABLE = {
  account: "commercial_accounts",
  contact: "commercial_contacts",
  deal: "commercial_opportunities",
  work_order: "commercial_work_orders",
  job: "commercial_jobs",
  change_order: "commercial_change_orders",
  invoice: "commercial_invoices",
  purchase: "commercial_project_purchases",
  project: "commercial_projects",
  file: "commercial_documents",
  employee: "commercial_employees",
  attendance: "commercial_time_entries",
};

/**
 * Re-record "what is here now is what we last wrote" for ONE entity.
 *
 * Needed because a write can move a row the importer did not touch: inserting a
 * payment fires the invoice's recompute trigger (migration 042), which bumps
 * `commercial_invoices.updated_at`. On the next run the guard sees an invoice
 * newer than its map stamp and concludes a person edited it — so Salesforce
 * updates to all 92 invoices would be refused, every day of the dual-run, by
 * the importer protecting the rows from itself.
 *
 * Called at the end of the stages that cascade. Narrow on purpose: a blanket
 * re-baseline after every run would also swallow a genuine edit made while the
 * run was in flight.
 */
async function restampEntity(entity) {
  const table = ENTITY_TABLE[entity];
  if (!COMMIT || !table || !COLUMNS.get(table)?.has("updated_at")) return 0;
  const stamps = new Map();
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from(table).select("id, updated_at").order("id").range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    for (const r of data ?? []) stamps.set(r.id, r.updated_at);
    if (!data || data.length < 1000) break;
    from += data.length;
  }
  const rows = [];
  for (const [key, rowId] of MAP) {
    if (!key.startsWith(`${entity}:`)) continue;
    const stamp = stamps.get(rowId);
    if (!stamp) continue;
    rows.push({ sf_id: key.slice(entity.length + 1), entity, row_id: rowId, updated_at: stamp });
    WROTE_AT.set(key, stamp);
  }
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from("commercial_import_map").upsert(rows.slice(i, i + 500), { onConflict: "sf_id,entity" });
    if (error) throw new Error(`import map (${entity}): ${error.message}`);
  }
  return rows.length;
}

async function rebaseline() {
  let total = 0, skipped = 0;
  for (const [entity, table] of Object.entries(ENTITY_TABLE)) {
    if (!COLUMNS.get(table)?.has("updated_at")) { console.log(`  ${entity}: no updated_at column — nothing to baseline`); continue; }
    // Current timestamps for the whole table, paginated.
    const stamps = new Map();
    let from = 0;
    for (;;) {
      const { data, error } = await sb.from(table).select("id, updated_at").order("id").range(from, from + 999);
      if (error) throw new Error(`${table}: ${error.message}`);
      for (const r of data ?? []) stamps.set(r.id, r.updated_at);
      if (!data || data.length < 1000) break;
      from += data.length;
    }
    const rows = [];
    let undated = 0, gone = 0;
    for (const [key, rowId] of MAP) {
      if (!key.startsWith(`${entity}:`)) continue;
      if (!stamps.has(rowId)) { gone += 1; skipped += 1; continue; }
      const stamp = stamps.get(rowId);
      // The column can exist and still be NULL — nothing has ever written
      // commercial_project_purchases.updated_at. Such a row cannot be judged,
      // so it stays unprotected until something stamps it (migration
      // 20260916140000 adds the trigger that will).
      if (!stamp) { undated += 1; skipped += 1; continue; }
      rows.push({ sf_id: key.slice(entity.length + 1), entity, row_id: rowId, updated_at: stamp });
    }
    if (COMMIT) {
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await sb.from("commercial_import_map").upsert(rows.slice(i, i + 500), { onConflict: "sf_id,entity" });
        if (error) throw new Error(`import map (${entity}): ${error.message}`);
      }
    }
    total += rows.length;
    const why = [];
    if (undated) why.push(`${undated} never stamped`);
    if (gone) why.push(`${gone} no longer here`);
    console.log(`  ${entity.padEnd(13)} ${String(rows.length).padStart(5)} row(s)${why.length ? `  (${why.join(" · ")})` : ""}`);
  }
  console.log(`
${COMMIT ? "Re-baselined" : "Would re-baseline"} ${total} row(s)${skipped ? ` · ${skipped} left unprotected (no usable timestamp)` : ""}.`);
  if (!COMMIT) console.log("Dry run. Re-run with --commit to write.");
}

// ─── go ─────────────────────────────────────────────────────────────────────

const conn = await salesforce();
await loadColumns();
await loadMap();
await loadSalesforce(conn);
console.log(`Salesforce: ${SF.opps.length} opportunities · ${SF.wos.length} work orders · ${SF.tx.length} transactions · ${SF.attendance.length} attendance rows`);
console.log(COMMIT ? "MODE: COMMIT — writing to Supabase" : RECONCILE ? "MODE: reconcile only" : "MODE: dry run — nothing will be written");

if (REBASELINE) {
  await rebaseline();
} else if (RECONCILE) {
  await reconcile();
} else {
  for (const stage of wanted) {
    const run = RUNNERS[stage];
    if (!run) { console.error(`unknown stage "${stage}" — one of: ${STAGES.join(", ")}`); process.exit(1); }
    printReport(await run());
  }
  if (!COMMIT) console.log("\nDry run. Re-run with --commit to write.");
}
