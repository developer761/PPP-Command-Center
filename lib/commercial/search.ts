/**
 * PostgREST search helpers (Karan 2026-07-27 audit).
 *
 * A raw user search term interpolated into a PostgREST `.or(...)` string is a
 * bug: commas are the top-level OR delimiter and parentheses are grouping, so a
 * real name like "Smith, Jones (NY)" corrupts the filter and the query 400s
 * (callers then swallow it and return []). Escaping the ilike wildcards +
 * wrapping the value in double quotes makes special chars data, not syntax.
 */

/**
 * Build a PostgREST-safe, double-quoted ilike term with `%…%` wildcards.
 * Use inside a `.or()` / `.ilike()` filter string:
 *   q.or(`company_name.ilike.${ilikeQuoted(search)},dba.ilike.${ilikeQuoted(search)}`)
 */
export function ilikeQuoted(search: string): string {
  const esc = search
    .replace(/[%_]/g, (m) => `\\${m}`) // ilike wildcards → literal
    .replace(/["\\]/g, (m) => `\\${m}`); // quote/backslash for the quoted value
  return `"%${esc}%"`;
}
