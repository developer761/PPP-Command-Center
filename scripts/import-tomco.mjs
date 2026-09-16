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
  OPEN_BID_STATUS,
  planInvoice,
  planInvoiceColumns,
  adjustmentLabel,
  invoiceStatus,
  purchaseCategory,
  isReimbursement,
  employeeFromCrewWorker,
  ymd,
} from "../lib/commercial/import/mapping.ts";

const TOMCO = "Corporate_Name__c='Tomco Painting'";
const STAGES = [
  "accounts", "contacts", "deals", "jobs", "change-orders",
  "invoices", "payments", "costs", "employees", "crews", "attendance", "files",
];

const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const RECONCILE = args.includes("--reconcile");
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
      .select("sf_id, entity, row_id")
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
    for (const r of data ?? []) MAP.set(`${r.entity}:${r.sf_id}`, r.row_id);
    if (!data || data.length < 1000) break;
    from += data.length;
  }
  console.log(`import map: ${MAP.size} row(s) already imported`);
}
const mapped = (entity, sfId) => MAP.get(`${entity}:${sfId}`) ?? null;

async function remember(entity, sfId, rowId, notes) {
  MAP.set(`${entity}:${sfId}`, rowId);
  if (!COMMIT) return;
  const { error } = await sb
    .from("commercial_import_map")
    .upsert({ sf_id: sfId, entity, row_id: rowId, notes: notes ?? null, updated_at: new Date().toISOString() }, { onConflict: "sf_id,entity" });
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
    const { error } = await sb.from(table).update(row).eq("id", existing);
    if (error) throw new Error(`${table} update ${sfId}: ${error.message}`);
    report.updated += 1;
    return existing;
  }
  const { data, error } = await sb.from(table).insert(row).select("id").single();
  if (error) throw new Error(`${table} insert ${sfId}: ${error.message}`);
  await remember(entity, sfId, data.id);
  report.inserted += 1;
  return data.id;
}

function newReport(stage) {
  return { stage, total: 0, would: 0, inserted: 0, updated: 0, skipped: [], sample: [] };
}

function printReport(r) {
  const head = COMMIT
    ? `${r.stage}: ${r.inserted} inserted, ${r.updated} updated`
    : `${r.stage}: would write ${r.would} row(s)`;
  console.log(`\n${head}`);
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
  SF.opps = await all(conn, `SELECT Id, Name, StageName, IsClosed, IsWon, CloseDate, CreatedDate, AccountId,
      Primary_Contact__c, Primary_Contact__r.Name, Primary_Contact__r.Email, Primary_Contact__r.Phone, Primary_Contact__r.Title,
      QuotedSubtotalWithChangeOrder__c, Amount, Estimation_Address__c, Service_Territory__c,
      Start_Date__c, End_Date__c, Owner.Name, Estimator__r.Name, ProjectManager__r.Name
      FROM Opportunity WHERE ${TOMCO}`);
  SF.wos = await all(conn, `SELECT Id, WorkOrderNumber, Name__c, Status, Opportunity__c, AccountId, Account.Name,
      Street, City, State, PostalCode, StartDate, EndDate, CreatedDate,
      Quoted_Subtotal_with_Change_Order__c, Original_Quoted_Subtotal__c, TotalChangeOrder__c, Tax, GrandTotal__c,
      TotalPaymentsIn__c, BalanceOwed__c, Customer_PO__c, Payment_Terms__c
      FROM WorkOrder WHERE (${TOMCO} OR Opportunity__r.${TOMCO}) AND Status != 'Canceled'`);
  const woIds = SF.wos.map((w) => `'${w.Id}'`).join(",");
  const oppIds = SF.opps.map((o) => `'${o.Id}'`).join(",");
  SF.accounts = await all(conn, `SELECT Id, Name, Phone, Website, BillingStreet, BillingCity, BillingState, BillingPostalCode,
      ShippingStreet, ShippingCity, ShippingState, ShippingPostalCode FROM Account WHERE Id IN (SELECT AccountId FROM Opportunity WHERE ${TOMCO})`);
  SF.contacts = await all(conn, `SELECT Id, Name, FirstName, LastName, Email, Phone, MobilePhone, Title, AccountId
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
  const docIds = [...new Set(SF.links.map((l) => l.ContentDocumentId))];
  SF.docs = [];
  for (let i = 0; i < docIds.length; i += 200) {
    SF.docs.push(...await all(conn, `SELECT Id, Title, FileExtension, FileType, ContentSize, LatestPublishedVersionId
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
    if (COMMIT && contactId) {
      const { error } = await sb.from("commercial_account_contacts")
        .upsert({ account_id: accountId, contact_id: contactId, role: "decision_maker", is_primary: true }, { onConflict: "account_id,contact_id,role" });
      if (error && !/duplicate/i.test(error.message)) throw new Error(`account_contacts: ${error.message}`);
    }
  }
  return r;
}

async function stageDeals() {
  const r = newReport("deals");
  for (const o of SF.opps) {
    // No lost jobs (Karan, 2026-09-15).
    if (o.IsClosed && !o.IsWon) continue;
    const accountId = mapped("account", o.AccountId);
    if (!accountId) { r.skipped.push(`${o.Name}: no imported GC account`); continue; }
    const wo = SF.woByOpp.get(o.Id);
    const st = wo ? dealStatusForWorkOrder(wo.Status) : OPEN_BID_STATUS;
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
      win_loss_debriefed_at: o.IsWon ? new Date().toISOString() : null,
      ppp_job_number: wo?.WorkOrderNumber || null,
      accepted_contract_cents: o.IsWon ? cents(wo?.Quoted_Subtotal_with_Change_Order__c ?? o.QuotedSubtotalWithChangeOrder__c) : null,
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
    const amount = cents(w.TotalChangeOrder__c);
    if (amount === 0) continue;
    const dealId = mapped("deal", w.Opportunity__c);
    const accountId = mapped("account", w.AccountId) ?? mapped("account", SF.opps.find((o) => o.Id === w.Opportunity__c)?.AccountId);
    if (!dealId || !accountId) { r.skipped.push(`${w.WorkOrderNumber}: deal or account missing`); continue; }
    await put("change_order", w.Id, "commercial_change_orders", {
      opportunity_id: dealId,
      account_id: accountId,
      co_number: `CO-${w.WorkOrderNumber}`,
      title: "Change orders carried over from Salesforce",
      description: "Salesforce tracks change-order VALUE per job, not individual change orders. This is that total, so the contract matches.",
      amount_cents: amount,
      status: "approved",
      decided_at: ymd(w.StartDate) ?? ymd(w.CreatedDate),
    }, r);
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
      issued_at: ymd(w.StartDate) ?? ymd(w.CreatedDate),
      // Set BEFORE payments land: the payment trigger stamps paid_at with now()
      // when it is null, which would date every historical job today.
      paid_at: plan.balanceCents <= 0 ? (ymd(w.EndDate) ?? ymd(w.StartDate) ?? ymd(w.CreatedDate)) : null,
      po_number: w.Customer_PO__c || null,
      payment_terms: w.Payment_Terms__c || null,
      notes: [`Imported from Salesforce work order ${w.WorkOrderNumber}.`, note].filter(Boolean).join(" "),
    }, r);
    if (COMMIT && invoiceId && note) {
      // The adjustment, as a line somebody can see and click.
      const { error } = await sb.from("commercial_invoice_line_items").upsert({
        invoice_id: invoiceId, position: 9000, description: note,
        quantity: 1, unit_price_cents: plan.adjustmentCents,
      }, { onConflict: "invoice_id,position" });
      if (error && !/duplicate|conflict/i.test(error.message)) r.skipped.push(`${w.WorkOrderNumber}: adjustment line — ${error.message}`);
    }
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
      paid_at: ymd(t.Date__c) ?? ymd(t.CreatedDate),
      method: (t.Method__c || "other").toLowerCase().includes("check") ? "check" : (t.Method__c || "other").toLowerCase().includes("ach") || (t.Method__c || "").toLowerCase().includes("wire") ? "ach" : "other",
      reference: t.ReferenceId__c || t.Name || null,
      notes: "Imported from Salesforce",
      deposited_at: t.Deposited__c ? ymd(t.Date__c) : null,
    }, r);
  }
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
      purchased_at: ymd(t.Date__c),
      description: t.Description__c || t.Name || null,
      reimburse_to: isReimbursement(kind) ? (t.Payee__r?.Name ?? null) : null,
      reimbursed_at: isReimbursement(kind) ? ymd(t.Date__c) : null,
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
      status: "closed",
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
  const byDay = new Map();
  for (const a of SF.attendanceInScope) {
    const jobId = jobForDeal.get(a.WorkOrder__c);
    const who = attendanceWho(a);
    const employeeId = who ? mapped("employee", who.key) : null;
    // One row carries 8 hours with no dates at all (Tomco Labor - JJ on AIREF
    // #2). Salesforce is being retired, so dropping real hours is worse than
    // dating them by the day the row was created — flagged, not hidden.
    const dated = ymd(a.StartDate__c) ?? ymd(a.EndDate__c);
    const workDate = dated ?? ymd(a.CreatedDate);
    if (!dated && workDate) r.skipped.push(`attendance ${a.Id}: no work date in Salesforce — dated ${workDate}, the day the row was created (${a.Hours_Worked__c ?? 0}h)`);
    if (!jobId || !employeeId || !workDate) {
      r.skipped.push(`attendance ${a.Id}: ${!jobId ? "no job" : !employeeId ? "no employee" : "no date at all"}`);
      continue;
    }
    const key = `attday:${a.WorkOrder__c}|${who.key}|${workDate}`;
    const hours = Number(a.Hours_Worked__c ?? 0);
    const prev = byDay.get(key);
    if (prev) prev.hours += hours;
    else byDay.set(key, { jobId, employeeId, workDate, hours });
  }

  for (const [key, day] of byDay) {
    const rounded = Math.round(day.hours * 100) / 100;
    // numeric(4,2) holds 99.99. Capping at 24 would look tidy and silently drop
    // hours that the reconciliation would then report as missing.
    const hours = Math.max(0, Math.min(99.99, rounded));
    if (hours !== rounded) r.skipped.push(`${key}: ${rounded}h is more than the column holds; stored ${hours}`);
    await put("attendance", key, "commercial_time_entries", {
      job_id: day.jobId,
      employee_id: day.employeeId,
      work_date: day.workDate,
      actual_hours: hours,
      source: "manual",
      status: "approved",
    }, r);
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
  return r;
}

const RUNNERS = {
  accounts: stageAccounts, contacts: stageContacts, deals: stageDeals, jobs: stageJobs,
  "change-orders": stageChangeOrders, invoices: stageInvoices, payments: stagePayments,
  costs: stageCosts, employees: stageEmployees, crews: stageCrews, attendance: stageAttendance,
  files: stageFiles,
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
  const sfMaterials = SF.txInScope.filter((t) => t.RecordType?.DeveloperName === "Purchase").reduce((n, t) => n + cents(t.Amount__c), 0);
  const sfLabor = SF.txInScope.filter((t) => t.RecordType?.DeveloperName === "Payment_Out" && t.PayeeType__c === "Labor_Company").reduce((n, t) => n + cents(t.Amount__c), 0);
  const hoursRows = await readAll("commercial_time_entries", "actual_hours");
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
  const hoursOk = Math.abs(ourHours - sfHours) < 0.01;
  if (!hoursOk) problems.push(`TOTAL hours: ours ${ourHours.toFixed(2)} vs Salesforce ${sfHours.toFixed(2)}`);
  console.log(`  ${hoursOk ? "✅" : "❌"} ${"attendance hours".padEnd(16)} ${ourHours.toFixed(1).padStart(16)}  ${sfHours.toFixed(1).padStart(16)}`);
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

// ─── go ─────────────────────────────────────────────────────────────────────

const conn = await salesforce();
await loadColumns();
await loadMap();
await loadSalesforce(conn);
console.log(`Salesforce: ${SF.opps.length} opportunities · ${SF.wos.length} work orders · ${SF.tx.length} transactions · ${SF.attendance.length} attendance rows`);
console.log(COMMIT ? "MODE: COMMIT — writing to Supabase" : RECONCILE ? "MODE: reconcile only" : "MODE: dry run — nothing will be written");

if (RECONCILE) {
  await reconcile();
} else {
  for (const stage of wanted) {
    const run = RUNNERS[stage];
    if (!run) { console.error(`unknown stage "${stage}" — one of: ${STAGES.join(", ")}`); process.exit(1); }
    printReport(await run());
  }
  if (!COMMIT) console.log("\nDry run. Re-run with --commit to write.");
}
