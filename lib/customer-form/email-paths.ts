import "server-only";

import { getSalesforceClient } from "@/lib/salesforce/client";

/**
 * Schema-driven discovery of every customer-email path reachable from a
 * WorkOrder. Replaces the "hardcode-the-paths-and-pray" approach that kept
 * missing PPP's actual location.
 *
 * Walks WorkOrder + Account + Opportunity + Contact describes once at first
 * call, finds every field whose type is "email" or whose name contains
 * "email", chases reference fields one level deep (WorkOrder → Contact /
 * Account / Opportunity, then Opportunity → Account / Contact, then Account
 * → its Primary_Contact lookup), and returns the full set of dotted paths
 * that can carry an email.
 *
 * Result is cached at module scope (schema doesn't change at runtime — a SF
 * field-add would require a redeploy anyway to pick up the new value).
 */

type SfField = {
  name: string;
  type: string;
  label?: string;
  referenceTo?: string[];
  relationshipName?: string | null;
};

type SfDescribeResult = { fields: SfField[] };

export type EmailPathDiscovery = {
  /** Dotted path from WorkOrder to an email field (e.g.
   *  "Opportunity__r.Account.PersonEmail" or "Contact.Email"). */
  emailPaths: string[];
  /** Dotted paths to an Account Id (used for the child-Contacts fallback). */
  accountIdPaths: string[];
  /** Dotted paths to a customer name field — used to pre-fill the modal's
   *  "Customer name" input when an email is found. */
  namePaths: string[];
};

let cached: EmailPathDiscovery | null = null;
let cacheBuiltAt = 0;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — survives normal use; resets on redeploy

function findEmailFields(meta: SfDescribeResult): string[] {
  return meta.fields
    .filter((f) => {
      if (f.type === "email") return true;
      const n = (f.name + " " + (f.label ?? "")).toLowerCase();
      return n.includes("email");
    })
    .map((f) => f.name);
}

function findReferenceFields(meta: SfDescribeResult): Array<{ field: string; relationshipName: string; referenceTo: string[] }> {
  return meta.fields
    .filter((f) => f.type === "reference" && f.relationshipName)
    .map((f) => ({ field: f.name, relationshipName: f.relationshipName!, referenceTo: f.referenceTo ?? [] }));
}

export async function discoverEmailPaths(opts?: { forceRefresh?: boolean }): Promise<EmailPathDiscovery> {
  if (!opts?.forceRefresh && cached && Date.now() - cacheBuiltAt < CACHE_TTL_MS) {
    return cached;
  }
  const conn = await getSalesforceClient();
  const [woMeta, accountMeta, oppMeta, contactMeta] = await Promise.all([
    conn.sobject("WorkOrder").describe() as unknown as Promise<SfDescribeResult>,
    conn.sobject("Account").describe() as unknown as Promise<SfDescribeResult>,
    conn.sobject("Opportunity").describe().catch(() => ({ fields: [] }) as SfDescribeResult) as Promise<SfDescribeResult>,
    conn.sobject("Contact").describe() as unknown as Promise<SfDescribeResult>,
  ]);

  const woEmailFields = findEmailFields(woMeta);
  const accountEmailFields = findEmailFields(accountMeta);
  const oppEmailFields = findEmailFields(oppMeta);
  const contactEmailFields = findEmailFields(contactMeta);

  const woRefs = findReferenceFields(woMeta);
  const oppRefs = findReferenceFields(oppMeta);
  const accountRefs = findReferenceFields(accountMeta);

  const emailPaths: string[] = [];
  const accountIdPaths: string[] = [];
  const namePaths: string[] = [];

  // 1. Direct WorkOrder email fields (custom Email__c on the WO itself)
  for (const f of woEmailFields) emailPaths.push(f);

  // 2. WorkOrder → Contact (standard FSL ContactId)
  const woContactRef = woRefs.find((r) => r.referenceTo.includes("Contact"));
  if (woContactRef) {
    for (const f of contactEmailFields) emailPaths.push(`${woContactRef.relationshipName}.${f}`);
    namePaths.push(`${woContactRef.relationshipName}.Name`);
  }

  // 3. WorkOrder → Account (standard FSL AccountId)
  const woAccountRef = woRefs.find((r) => r.referenceTo.includes("Account"));
  if (woAccountRef) {
    for (const f of accountEmailFields) emailPaths.push(`${woAccountRef.relationshipName}.${f}`);
    accountIdPaths.push(`${woAccountRef.relationshipName}.Id`);
    namePaths.push(`${woAccountRef.relationshipName}.Name`);
    // Account → Primary_Contact / similar Contact lookup → Email
    for (const acctRef of accountRefs) {
      if (acctRef.referenceTo.includes("Contact")) {
        for (const f of contactEmailFields) {
          emailPaths.push(`${woAccountRef.relationshipName}.${acctRef.relationshipName}.${f}`);
        }
      }
    }
  }

  // 4. WorkOrder → Opportunity (PPP's custom Opportunity__c)
  const woOppRef = woRefs.find((r) => r.referenceTo.includes("Opportunity"));
  if (woOppRef) {
    for (const f of oppEmailFields) emailPaths.push(`${woOppRef.relationshipName}.${f}`);
    // Opportunity → Account → email
    const oppAcctRef = oppRefs.find((r) => r.referenceTo.includes("Account"));
    if (oppAcctRef) {
      for (const f of accountEmailFields) emailPaths.push(`${woOppRef.relationshipName}.${oppAcctRef.relationshipName}.${f}`);
      accountIdPaths.push(`${woOppRef.relationshipName}.${oppAcctRef.relationshipName}.Id`);
      namePaths.push(`${woOppRef.relationshipName}.${oppAcctRef.relationshipName}.Name`);
      // Opportunity → Account → Primary_Contact → email
      for (const acctRef of accountRefs) {
        if (acctRef.referenceTo.includes("Contact")) {
          for (const f of contactEmailFields) {
            emailPaths.push(`${woOppRef.relationshipName}.${oppAcctRef.relationshipName}.${acctRef.relationshipName}.${f}`);
          }
        }
      }
    }
    // Opportunity → Contact (PPP often has Primary_Contact__c on Opp)
    for (const oppRef of oppRefs) {
      if (oppRef.referenceTo.includes("Contact")) {
        for (const f of contactEmailFields) {
          emailPaths.push(`${woOppRef.relationshipName}.${oppRef.relationshipName}.${f}`);
        }
        namePaths.push(`${woOppRef.relationshipName}.${oppRef.relationshipName}.Name`);
      }
    }
  }

  cached = {
    emailPaths: Array.from(new Set(emailPaths)),
    accountIdPaths: Array.from(new Set(accountIdPaths)),
    namePaths: Array.from(new Set(namePaths)),
  };
  cacheBuiltAt = Date.now();
  console.log(`[customer-form] email-path discovery — ${cached.emailPaths.length} paths cached: ${cached.emailPaths.slice(0, 10).join(", ")}${cached.emailPaths.length > 10 ? "…" : ""}`);
  return cached;
}

/** Walk a dotted path through a SOQL response record. */
export function readPath(rec: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = rec;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur ?? null;
}
