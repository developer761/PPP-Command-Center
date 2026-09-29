import "server-only";

import { getSalesforceClient } from "@/lib/salesforce/client";
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
 * Katie's daily Stripe finance job (planned) — and both use ReferenceId__c =
 * the pi_… id. Whoever writes second finds the first and stops, so one
 * payment is never booked twice.
 */
export async function findTransactionByReference(paymentIntentId: string): Promise<string | null> {
  if (!/^pi_[A-Za-z0-9]+$/.test(paymentIntentId)) return null;
  const conn = await getSalesforceClient();
  const r = await conn.query<{ Id: string }>(
    `SELECT Id FROM Transaction__c WHERE ReferenceId__c = '${paymentIntentId}' LIMIT 1`,
  );
  return r.records[0]?.Id ?? null;
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
