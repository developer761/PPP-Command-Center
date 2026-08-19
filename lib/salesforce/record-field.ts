/**
 * Read a field off a Salesforce record without guessing its casing.
 *
 * SOQL field names are case-INSENSITIVE, but the JSON that comes back is keyed
 * by the field's REAL API name. So `SELECT FollowupDate__c` succeeds against a
 * field actually called `FollowUpDate__c`, and then
 * `record["FollowupDate__c"]` is undefined. No error is raised at any point.
 *
 * That combination is nasty: the usual defence — "try one casing, catch
 * INVALID_FIELD, retry the other" — never fires, because the query didn't fail.
 * It cost the Mail Hub's follow-up-date filter twice (Kate round-3 #13 and
 * round-4 #34): every date resolved to null, so the filter matched nothing on
 * any date, which reads as a broken filter rather than a missing field.
 *
 * Verified against the live org: querying "FollowupDate__c" returns
 * `{ Id, FollowUpDate__c: "2026-08-14" }`.
 */
export function sfField(
  record: Record<string, unknown> | null | undefined,
  apiName: string
): unknown {
  if (!record) return undefined;
  // Exact hit first — the common case, and avoids scanning keys.
  if (Object.prototype.hasOwnProperty.call(record, apiName)) return record[apiName];
  const wanted = apiName.toLowerCase();
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === wanted) return record[key];
  }
  return undefined;
}

/** `sfField` narrowed to a non-empty string — the usual case for dates/text. */
export function sfString(
  record: Record<string, unknown> | null | undefined,
  apiName: string
): string | null {
  const v = sfField(record, apiName);
  return typeof v === "string" && v ? v : null;
}

/** A Salesforce Date field ("YYYY-MM-DD"), trimmed of any time component. */
export function sfDate(
  record: Record<string, unknown> | null | undefined,
  apiName: string
): string | null {
  const v = sfString(record, apiName);
  return v ? v.slice(0, 10) : null;
}
