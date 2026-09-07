/**
 * Push an opt-out back into Salesforce.
 *
 * Replaces the path that is currently losing people. Today: Hatch fires a
 * webhook, Apex matches on the last ten digits of a phone or an exact email,
 * and if neither matches an error email goes to info@ and a person is expected
 * to update the record by hand. Kate's own analysis of that path:
 *
 *     213  notifications Salesforce could not match
 *      98  had no Salesforce record at all
 *      55  matched a record STILL not marked opted out
 *      50  of those with the record sitting right there when it fired
 *
 * The failure is the human transcription step. This removes it.
 *
 * Two design points that follow directly from that data.
 *
 * ONE. Match on BOTH phone and email, and try Lead and Contact both. Kate's
 * Apex already does this; 92 of the 213 arrived over email, so a phone-only
 * match would miss them. Where the existing path differs is what happens on a
 * miss — see below.
 *
 * TWO. A miss is not a failure. 98 of those 213 had no Salesforce record
 * because the person opted out before one existed. Emailing info@ and hoping
 * treats that as an error; it is not. Our suppression list already holds the
 * opt-out, so the Salesforce write is an ENRICHMENT, and an unmatched one is
 * recorded as pending rather than lost. If a record appears later, the pending
 * row is still there to be applied.
 *
 * Pure: the caller supplies the matcher and the writer.
 */
import type { E164 } from "./phone";

export type SfMatch = {
  sObject: "Lead" | "Contact";
  id: string;
  /** Which field matched, for the audit trail. */
  matchedOn: "phone" | "email";
};

export type OptOutTarget = { phone: E164 | null; email: string | null };

export type WritebackDeps = {
  /** Every Lead and Contact matching either identifier. */
  findRecords(target: OptOutTarget): Promise<SfMatch[]>;
  /** Set the opt-out fields on one record. */
  setOptOut(m: SfMatch, fields: OptOutFields): Promise<void>;
};

/**
 * Which Salesforce fields to set.
 *
 * Names taken from Kate's own Lead Remove Rules, so this writes what her
 * workflows already read. Setting only the SMS field when somebody opted out
 * of email would leave them enrolled in the email half of a campaign.
 */
export type OptOutFields = {
  SMS_Opt_In__c?: "Opt-Out";
  Email_Opt_In__c?: "Opt-Out";
  HasOptedOutOfEmail?: true;
};

export function fieldsFor(channel: "sms" | "email" | "both"): OptOutFields {
  if (channel === "sms") return { SMS_Opt_In__c: "Opt-Out" };
  if (channel === "email") return { Email_Opt_In__c: "Opt-Out", HasOptedOutOfEmail: true };
  return { SMS_Opt_In__c: "Opt-Out", Email_Opt_In__c: "Opt-Out", HasOptedOutOfEmail: true };
}

export type WritebackResult = {
  status: "written" | "pending_no_record" | "failed";
  updated: SfMatch[];
  /** Records that could not be written. Partial success is real: a Lead may
   *  update while a Contact fails on permissions, and reporting the whole
   *  thing as failed would hide the half that worked. */
  errors: { record: SfMatch; message: string }[];
  detail: string;
};

export async function writeOptOutToSalesforce(
  target: OptOutTarget,
  channel: "sms" | "email" | "both",
  deps: WritebackDeps
): Promise<WritebackResult> {
  if (!target.phone && !target.email) {
    return { status: "failed", updated: [], errors: [], detail: "no phone or email to match on" };
  }

  let matches: SfMatch[];
  try {
    matches = await deps.findRecords(target);
  } catch (err) {
    return {
      status: "failed", updated: [], errors: [],
      detail: `lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (matches.length === 0) {
    // Expected, and not an error. The suppression already holds; this is the
    // 98-of-213 case, and it stays pending so a record appearing later can
    // still be updated.
    return {
      status: "pending_no_record", updated: [], errors: [],
      detail: "no Salesforce record matched yet — suppression is already in effect here",
    };
  }

  const fields = fieldsFor(channel);
  const updated: SfMatch[] = [];
  const errors: WritebackResult["errors"] = [];

  // Every match, not the first. A person can exist as both a Lead and a
  // Contact, and Kate's remove rules read fields on both — updating only one
  // leaves a campaign still able to pick them up through the other.
  for (const m of matches) {
    try {
      await deps.setOptOut(m, fields);
      updated.push(m);
    } catch (err) {
      errors.push({ record: m, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    status: updated.length > 0 ? "written" : "failed",
    updated, errors,
    detail: errors.length === 0
      ? `updated ${updated.length} record${updated.length === 1 ? "" : "s"}`
      : `updated ${updated.length}, failed ${errors.length}`,
  };
}
