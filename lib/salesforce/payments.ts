import "server-only";

import { getPaymentsSalesforceClient as getSalesforceClient } from "@/lib/salesforce/payments-org";
import type { PaymentTermInput } from "@/lib/payments/schedule";

/**
 * Salesforce reads for online invoice payments.
 *
 * Always LIVE — never the snapshot cache. This decides how much money to take
 * from a customer; a five-minute-old balance is how someone pays a deposit
 * twice. One Work Order and its handful of terms is two small queries.
 *
 * Lives under lib/salesforce/ so `npm run check:sf-fields` checks these SELECTs
 * against the org's describe.
 *
 * Every call goes through getPaymentsSalesforceClient — production normally,
 * the sandbox when PAYMENTS_SF_ORG=sandbox (see payments-org.ts). Nothing here
 * may use the app-wide client directly.
 */

export type WorkOrderPaymentState = {
  id: string;
  number: string;
  status: string | null;
  balanceOwed: number | null;
  totalCharges: number | null;
  totalPaymentsIn: number | null;
  /** WorkOrder.Opportunity__c — linked on the Payment In, as Katie's Stripe job does. */
  opportunityId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  terms: PaymentTermInput[];
};

/** Work Order statuses where the job is over and nothing should be collected online. */
const CLOSED_STATUSES = new Set(["Closed", "Cancelled", "Canceled"]);
export function isClosedForPayment(status: string | null): boolean {
  return status != null && CLOSED_STATUSES.has(status);
}

type WoRow = {
  Id: string;
  WorkOrderNumber: string;
  Status: string | null;
  BalanceOwed__c: number | null;
  TotalCustomerCharges__c: number | null;
  TotalPaymentsIn__c: number | null;
  Opportunity__c: string | null;
  Street: string | null;
  City: string | null;
  State: string | null;
  PostalCode: string | null;
  Contact: { Name: string | null; Email: string | null } | null;
};

type TermRow = {
  Id: string;
  Payment_Type__c: string | null;
  Order__c: number | null;
  Amount__c: number | null;
  Percent__c: number | null;
  Value_Type__c: string | null;
  Paid_In_Full__c: boolean | null;
};

const SF_ID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
const WO_NUMBER_RE = /^\d{1,10}$/;

async function loadWorkOrder(where: string): Promise<WorkOrderPaymentState | null> {
  const conn = await getSalesforceClient();
  const wo = await conn.query<WoRow>(
    `SELECT Id, WorkOrderNumber, Status, BalanceOwed__c, TotalCustomerCharges__c, TotalPaymentsIn__c, Opportunity__c, Street, City, State, PostalCode, Contact.Name, Contact.Email FROM WorkOrder WHERE ${where} LIMIT 1`,
  );
  const w = wo.records[0];
  if (!w) return null;

  const terms = await conn.query<TermRow>(
    `SELECT Id, Payment_Type__c, Order__c, Amount__c, Percent__c, Value_Type__c, Paid_In_Full__c FROM Payment_Term__c WHERE WorkOrder__c = '${w.Id}'`,
  );

  return {
    id: w.Id,
    number: w.WorkOrderNumber,
    status: w.Status,
    balanceOwed: w.BalanceOwed__c,
    totalCharges: w.TotalCustomerCharges__c,
    totalPaymentsIn: w.TotalPaymentsIn__c,
    opportunityId: w.Opportunity__c,
    contactName: w.Contact?.Name ?? null,
    contactEmail: w.Contact?.Email ?? null,
    street: w.Street,
    city: w.City,
    state: w.State,
    postalCode: w.PostalCode,
    terms: terms.records.map((t) => ({
      id: t.Id,
      type: t.Payment_Type__c,
      order: t.Order__c,
      amount: t.Amount__c,
      percent: t.Value_Type__c === "Percent" ? t.Percent__c : null,
      paidInFull: t.Paid_In_Full__c === true,
    })),
  };
}

export async function getWorkOrderPaymentStateById(id: string): Promise<WorkOrderPaymentState | null> {
  if (!SF_ID_RE.test(id)) return null;
  return loadWorkOrder(`Id = '${id}'`);
}

/** Accepts "313399" or "00313399" — people drop the leading zeros. */
export async function getWorkOrderPaymentStateByNumber(raw: string): Promise<WorkOrderPaymentState | null> {
  const digits = raw.trim().replace(/^#/, "");
  if (!WO_NUMBER_RE.test(digits)) return null;
  return loadWorkOrder(`WorkOrderNumber = '${digits.padStart(8, "0")}'`);
}

/** Transaction__c record type for money coming in. Resolved by name, not a hardcoded Id. */
export async function getPaymentInRecordTypeId(): Promise<string> {
  const conn = await getSalesforceClient();
  const d = await conn.sobject("Transaction__c").describe();
  // The describe returns developerName; jsforce's RecordTypeInfo type omits it.
  const infos = d.recordTypeInfos as Array<{ developerName?: string; recordTypeId?: string | null }>;
  const rt = infos.find((r) => r.developerName === "Payment_In");
  if (!rt?.recordTypeId) throw new Error("Transaction__c has no Payment_In record type");
  return rt.recordTypeId;
}

/**
 * An existing Transaction__c for this Stripe payment, if anyone already booked
 * it. Two systems can write Stripe payments into Salesforce — this one, and
 * Katie's daily Stripe finance job / Ruben by hand — with two conventions for
 * the Stripe id. Whoever writes second finds the first and stops, so one
 * payment is never booked twice.
 */
export async function findTransactionByReference(paymentIntentId: string): Promise<string | null> {
  if (!/^pi_[A-Za-z0-9]+$/.test(paymentIntentId)) return null;
  const conn = await getSalesforceClient();
  // Two conventions for "this Stripe payment": ReferenceId__c = pi_… (ours), and
  // Description__c containing "Stripe pi_…" (Ruben's, used by Katie's job and
  // by hand entries). Either one means it's already booked. Two queries rather
  // than one OR, so the exact ReferenceId__c match is tried first.
  const byRef = await conn.query<{ Id: string }>(
    `SELECT Id FROM Transaction__c WHERE ReferenceId__c = '${paymentIntentId}' LIMIT 1`,
  );
  if (byRef.records[0]) return byRef.records[0].Id;
  const byDesc = await conn.query<{ Id: string }>(
    `SELECT Id FROM Transaction__c WHERE Description__c LIKE '%${paymentIntentId}%' LIMIT 1`,
  );
  return byDesc.records[0]?.Id ?? null;
}

export async function createSalesforceTransaction(
  fields: Record<string, string | number | boolean | null>,
): Promise<string> {
  const conn = await getSalesforceClient();
  const res = await conn.sobject("Transaction__c").create(fields);
  if (!("success" in res) || !res.success) {
    const errs = "errors" in res ? JSON.stringify(res.errors) : "unknown error";
    throw new Error(`Salesforce refused the Transaction__c: ${errs}`);
  }
  return res.id;
}

// ─── The invoice's pay link ─────────────────────────────────────────────────

let _hasUrlField: { org: string; value: boolean } | null = null;

/** Does Work Order have Online_Payment_URL__c in the org the payments code is
 *  on? It's created by Katie's deploy; until it lands, link writes are skipped
 *  (and say so) rather than failing. */
export async function workOrderHasPaymentUrlField(): Promise<boolean> {
  const conn = await getSalesforceClient();
  if (_hasUrlField?.org === conn.instanceUrl) return _hasUrlField.value;
  const d = await conn.sobject("WorkOrder").describe();
  const f = d.fields.find((x) => x.name === "Online_Payment_URL__c");
  const value = Boolean(f?.updateable);
  _hasUrlField = { org: conn.instanceUrl, value };
  return value;
}

/** Put a pay link on the Work Order (S-Docs prints it on the invoice), or
 *  clear it (null) so the invoice falls back to the old Stripe link. */
export async function setWorkOrderPaymentUrl(
  workOrderId: string,
  url: string | null,
  workOrderNumber: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!SF_ID_RE.test(workOrderId)) return { ok: false, reason: "bad Work Order id" };
  if (!(await workOrderHasPaymentUrlField())) {
    return { ok: false, reason: "Online_Payment_URL__c isn't on Work Order in this Salesforce org yet" };
  }
  const { writeSf } = await import("@/lib/salesforce/writeback");
  const { paymentsOrg } = await import("@/lib/salesforce/payments-org");
  const res = await writeSf(
    { sObject: "WorkOrder", recordId: workOrderId, fields: { Online_Payment_URL__c: url } },
    {
      source: "online_payment",
      workOrderNumber,
      connection: paymentsOrg() === "sandbox" ? await getSalesforceClient() : undefined,
    },
  );
  return res.ok ? { ok: true } : { ok: false, reason: res.error };
}

/**
 * Open Work Orders that should have a pay link and don't: money still owed,
 * payment terms set up, not closed, no link yet — and not a licensee's job
 * (DHES / Krebill invoices hide PPP's payment details; see the User flags).
 */
export async function listWorkOrdersNeedingPayLinks(
  limit = 200,
): Promise<{ workOrders: { id: string; number: string }[]; licenseeFilter: "applied" | "unavailable" }> {
  const conn = await getSalesforceClient();
  const hasField = await workOrderHasPaymentUrlField();
  // The licensee flags are User custom fields, but field-level security can
  // hide them from the Command Center's login — in production on 2026-10-08
  // they weren't visible at all. Use them when they're readable; when they
  // aren't, say so (the admin page shows it) rather than fail or guess.
  const userFields = new Set((await conn.sobject("User").describe()).fields.map((f) => f.name));
  const flags = ["Licensee_DHES__c", "Licensee_Krebill__c"].filter((f) => userFields.has(f));
  let exclude: string[] = [];
  if (flags.length === 2) {
    const licensees = await conn.query<{ Id: string }>(
      `SELECT Id FROM User WHERE ${flags.map((f) => `${f} = true`).join(" OR ")}`,
    );
    exclude = licensees.records.map((u) => `'${u.Id}'`);
  }
  const where = [
    "Status NOT IN ('Closed', 'Canceled', 'Complete Paid in Full')",
    "BalanceOwed__c > 0",
    "Total_Payment_Terms__c > 0",
    hasField ? "Online_Payment_URL__c = null" : null,
    exclude.length ? `OwnerId NOT IN (${exclude.join(",")})` : null,
  ].filter(Boolean);
  const r = await conn.query<{ Id: string; WorkOrderNumber: string }>(
    `SELECT Id, WorkOrderNumber FROM WorkOrder WHERE ${where.join(" AND ")} ORDER BY CreatedDate DESC LIMIT ${Math.min(limit, 2000)}`,
  );
  return {
    workOrders: r.records.map((w) => ({ id: w.Id, number: w.WorkOrderNumber })),
    licenseeFilter: flags.length === 2 ? "applied" : "unavailable",
  };
}
