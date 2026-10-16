/**
 * The committed exceptions to the commercial API authorization rules.
 *
 * Every entry here is a DECISION somebody made, visible in a diff, with a
 * reason written down. That is the whole point: the class of bug this guards
 * against — "roughly two dozen commercial API routes never funnelled through
 * that helper" (lib/commercial/auth.ts:141) — was invisible precisely because
 * nothing ever listed which routes were supposed to be open.
 *
 * Adding a route here is not a workaround. It is a claim, in writing, that the
 * data behind it is safe for the audience named in the reason. Reviewers: read
 * the reason, then go and check it.
 *
 * Paths are relative to app/api/commercial/, without the trailing /route.ts.
 */

/**
 * UNGATED — routes that reach NO authorization gate at all.
 *
 * There should essentially never be more than one of these.
 */
export const UNGATED = [
  {
    route: "bid-submit",
    reason:
      "PUBLIC by design. The /c/bid-submit form is linked from Tomco's own " +
      "website for general contractors with no login. Write-only: it creates " +
      "an account + a 'web' opportunity and notifies the team, and reads " +
      "nothing back out. Defended by a honeypot field, Cloudflare Turnstile " +
      "and a per-IP rate limit instead of a session.",
  },
];

/**
 * CREW-OPEN — routes that DO reach a gate but opt crew logins back in with
 * `allowCrew: true`.
 *
 * Crew is the one real user boundary this platform has (lib/commercial/
 * crew-access.ts). Opting out of it is the single highest-leverage change
 * anyone can make to the authorization model, so it must be deliberate.
 */
export const CREW_OPEN = [
  {
    route: "field-ops/kiosk-clock",
    reason:
      "The Clock Station on a shared shop tablet. A painter proves identity " +
      "with a 4-digit PIN rather than a login, so the route must admit crew. " +
      "Narrowed in the handler: a crew caller may only act on THEIR OWN " +
      "employee_id (the body's employee_id is checked against the caller), " +
      "and non-admin PIN brute-forcing was closed in audit round 2.",
  },
];

/**
 * SOFT-GATE-ONLY — handlers whose only boundary is `assertCommercialAccess` or
 * `requireCommercialUser`.
 *
 * Those two DO default-deny crew (lib/commercial/auth.ts:78-81), so a route
 * reaching one is not fail-open. But they deny by calling `redirect()`, which
 * throws: in a route handler that becomes a 307 to the crew home page, or —
 * if the call sits inside a try/catch — whatever the catch decides. The API
 * gates return a 403 Response and cannot be swallowed.
 *
 * Mixing the two forms is how the original class came back: a reviewer reading
 * a handler cannot tell a real gate from a near-miss at a glance. Keep this
 * list EMPTY; a soft-gated route is a two-line patch away from a hard one.
 */
export const SOFT_GATE_ONLY = [];

/**
 * GET-WRITES — GET handlers that reach .insert/.update/.delete/.upsert.
 *
 * A GET is fetched by a prefetch, a crawler, a link in an email, an <img> tag,
 * a browser restoring tabs. The session cookie here is SameSite=Lax, which
 * means a top-level GET navigation from ANY site arrives authenticated — so a
 * writing GET is a one-click CSRF with no token to forge.
 *
 * Keep this list at ONE entry. A route that genuinely must write is a POST.
 */
export const GET_WRITES = [
  {
    route: "field-ops/payroll/export",
    reason:
      "FLOW-INSENSITIVE FALSE POSITIVE, re-verified 2026-10-16. GET and POST " +
      "share one `handleExport(request, method)`, so the call graph reaches " +
      "exportPayroll() from both. At runtime the GET cannot: `if (!redownload " +
      "&& method !== 'POST') return NextResponse.redirect(back)` returns " +
      "before the write, and the redownload branch calls redownloadPayroll(), " +
      "which only reads. This is the route whose GET used to lock three weeks " +
      "of pay irreversibly via a crafted link — the fix was moving the lock to " +
      "POST, and it is still in place. If you touch handleExport, re-read that " +
      "branch before trusting this entry.",
  },
];

/**
 * What makes a `.insert/.update/.delete/.upsert` a DATABASE write.
 *
 * Matched POSITIVELY against the receiver expression, not as a denylist of
 * things to ignore. `profileCache.delete(k)`, `dedupBuffer.delete(k)` and
 * `crypto.createHash(...).update(x)` are the same four method names and mean
 * nothing like a mutation; a denylist would have to guess every one of them in
 * advance, and the one it missed would be a permanent false positive that
 * teaches everyone to skip the output.
 *
 * A bare identifier receiver is resolved to its own initializer first, so
 * `const q = sb.from("x"); q.update(...)` still matches.
 */
export const DB_WRITE_RECEIVER = [
  /\.from\s*\(/,
  /\.rpc\s*\(/,
  /\.schema\s*\(/,
  /\bcommercialDb\s*\(/,
  /\bserviceClient\s*\(/,
  /\bsupabaseAdmin\b/,
];
