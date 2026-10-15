/**
 * Putting a value into a SOQL string safely.
 *
 * 🔴 WHY A MODULE FOR TWO FUNCTIONS. Every query in the Tomco write-back is
 * built by interpolation, and the escaping was `replace(/'/g, "\\'")` — the
 * quote escaped, the BACKSLASH not. So a GC name ending in a backslash, or
 * containing `\'`, leaves a live quote in the query: `Acme\'` becomes `Acme\\'`,
 * which SOQL reads as an escaped backslash followed by a string terminator.
 *
 * The damage is not a dropped table — these are read queries — it is worse in a
 * quiet way. `WHERE Name = '<gc>'` is the ACCOUNT RESOLVER, and the caller does
 * `if (records.length === 1) accountId = records[0].Id`. A crafted or merely
 * malformed company name can make that return a single WRONG account, and that
 * id is then written as `AccountId` on a Closed Won opportunity — hanging a
 * Tomco sale off another general contractor's page. A malformed name instead
 * throws MALFORMED_QUERY, which the tick counts as a failed attempt; three of
 * those and the entry stops asking.
 *
 * `commercial_accounts.company_name` is typed by a person, so neither case is
 * hypothetical.
 */

/**
 * Escape a string for use inside single quotes in SOQL.
 *
 * Backslash FIRST, then the quote — the other order double-escapes the
 * backslashes it has just inserted.
 */
export function soqlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * A Salesforce id, or a thrown error.
 *
 * Ids reach queries from our own database and from form posts, and an id is
 * never a place where an escape is the right answer: a value that is not an id
 * is a bug or an attack, and either way the query should not run. 15 or 18
 * characters, alphanumeric — Salesforce's own shape.
 */
export function assertSalesforceId(value: string, what = "Salesforce id"): string {
  if (!/^[a-zA-Z0-9]{15,18}$/.test(value)) {
    throw new Error(`${what} is not a Salesforce id: ${JSON.stringify(String(value).slice(0, 40))}`);
  }
  return value;
}
