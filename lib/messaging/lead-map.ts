/**
 * A Salesforce Lead, as the intake and the entry rules need it.
 *
 * Pure, so the mapping is tested without Salesforce. Field names checked
 * against the live Lead describe on 2026-09-15: Phone and MobilePhone are both
 * phone fields; RecordType is a reference whose Name is what the seeded entry
 * rules compare ("Web Inquiry", "Phone Inquiry"); SMS_Opt_In__c is a picklist.
 */
import type { IncomingLead } from "./lead-intake";
import type { LeadRecord } from "./rules";

/** Exactly the fields the poll asks for. Adding one means adding it to SOQL. */
export const LEAD_FIELDS = [
  "Id", "Name", "FirstName", "Phone", "MobilePhone", "Email", "LeadSource",
  // STREET. City, State and PostalCode were already here and Street was not,
  // so the lead's address could never be assembled, which meant the bot asked
  // for an address we were already holding. That is A13, the redundant ask,
  // and it is the second most broken rule in Kate's grading.
  "Street",
  "State", "City", "PostalCode", "RecordType.Name", "CreatedDate", "Status",
  "IsConverted", "SMS_Opt_In__c", "LeadGroup__c",
] as const;

export type SalesforceLead = {
  Id: string;
  Name?: string | null;
  FirstName?: string | null;
  Phone?: string | null;
  MobilePhone?: string | null;
  Email?: string | null;
  LeadSource?: string | null;
  Street?: string | null;
  State?: string | null;
  City?: string | null;
  PostalCode?: string | null;
  RecordType?: { Name?: string | null } | null;
  CreatedDate?: string | null;
  Status?: string | null;
  IsConverted?: boolean | null;
  SMS_Opt_In__c?: string | null;
  LeadGroup__c?: string | null;
};

/**
 * The lead's address as one line, or null when there is not enough of one.
 *
 * A11 defines a full address as street plus zip, so anything without both is
 * NOT an address we can claim to hold: offering it back for confirmation
 * would be reading half a record to somebody who then has to correct it. City
 * and state are included when present because they make the read-back sound
 * like a person, but they are never what makes it complete.
 */
export function composeAddress(r: SalesforceLead): string | null {
  const street = r.Street?.trim();
  const zip = r.PostalCode?.trim();
  if (!street || !zip) return null;
  const middle = [r.City?.trim(), stateCode(r.State)].filter(Boolean).join(", ");
  return [street, middle, zip].filter(Boolean).join(", ");
}

const US_STATES: Record<string, string> = {
  "new york": "NY", "new jersey": "NJ", "florida": "FL", "connecticut": "CT",
  "california": "CA", "colorado": "CO", "pennsylvania": "PA", "texas": "TX",
};

/** "New York", "ny", "N.Y." → "NY". Unknown stays null rather than guessed. */
export function stateCode(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length === 2) return letters.toUpperCase();
  return US_STATES[t.toLowerCase()] ?? null;
}

export function leadFromSalesforce(r: SalesforceLead): { lead: IncomingLead; record: LeadRecord } {
  // Mobile first: it is the number that can take a text. A landline in Phone
  // would burn the first touch on a number that cannot receive it.
  const phone = r.MobilePhone?.trim() || r.Phone?.trim() || null;
  const lead: IncomingLead = {
    sfRecordId: r.Id,
    phone,
    email: r.Email ?? null,
    fullName: r.Name ?? null,
    leadSource: r.LeadSource ?? null,
    state: stateCode(r.State),
    locality: r.City ?? null,
    postalCode: r.PostalCode ?? null,
    street: r.Street?.trim() || null,
    address: composeAddress(r),
    sfCreatedAt: r.CreatedDate ?? null,
  };
  // What the entry and exit rules read. RecordType flattened to its name,
  // which is what the seeded rules compare.
  const record: LeadRecord = {
    ...r,
    RecordType: r.RecordType?.Name ?? null,
  };
  return { lead, record };
}
