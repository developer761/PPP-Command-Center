import "server-only";

/**
 * Tiny in-memory token-bucket rate limiter.
 *
 * Designed for the public customer-form submit endpoint — the one path on the
 * platform that ANY unauthenticated person with a leaked token can hammer.
 * The submit handler is idempotent (markSubmitted guards against double-write),
 * but a botnet could still:
 *   - burn SF API calls (drift detection + writeSfBatch fire on every attempt
 *     until the token is marked submitted),
 *   - exhaust Vercel function-invocations on Hobby plans,
 *   - flood the audit log with retry noise.
 *
 * Limit: default 5 attempts per minute per key. The customer-form happy path
 * is ONE submit per token; 5 covers a double-tap, a tab-restored re-submit,
 * and one retry after a transient error — anything beyond that is abuse.
 *
 * Storage: in-process Map. On Vercel, each serverless instance has its own
 * map, so per-key limits are effectively "5 per minute per instance per key."
 * Vercel routes can spin up multiple instances under load, so the actual cap
 * is "5 × instance count" — still tight enough to stop a botnet, loose
 * enough to never block a real customer. A KV-backed implementation is a
 * better fit if/when we see real abuse.
 *
 * Stickier dev-server behavior: since the map lives on globalThis in dev, HMR
 * survives. In prod it's per-process which auto-resets on cold start.
 *
 * Round 4 audit (2026-06-04) flagged the public surface as unprotected.
 */

type Bucket = { count: number; resetAt: number };

const STORE: Map<string, Bucket> =
  process.env.NODE_ENV === "development"
    ? ((globalThis as unknown as { __pppRateLimitStore?: Map<string, Bucket> }).__pppRateLimitStore ??= new Map())
    : new Map();

export type RateLimitResult = {
  /** True when the request is allowed; false when blocked. */
  ok: boolean;
  /** Remaining attempts before block (0 when ok=false). */
  remaining: number;
  /** Unix ms when the bucket resets. Useful for Retry-After header. */
  resetAt: number;
};

/**
 * Check + bump a rate-limit bucket atomically.
 *
 *   const r = checkRateLimit(`submit:${token}`, { max: 5, windowMs: 60_000 });
 *   if (!r.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
 *
 * @param key Unique bucket identifier — use a stable, hard-to-guess prefix
 *            + the user-controlled discriminator (token, IP, etc.).
 * @param opts max = bucket capacity, windowMs = time before reset (in ms).
 */
export function checkRateLimit(
  key: string,
  opts: { max: number; windowMs: number }
): RateLimitResult {
  const now = Date.now();
  const cur = STORE.get(key);
  if (!cur || cur.resetAt < now) {
    // Fresh bucket — first request in the window. Count = 1 (this request).
    const bucket = { count: 1, resetAt: now + opts.windowMs };
    STORE.set(key, bucket);
    return { ok: true, remaining: opts.max - 1, resetAt: bucket.resetAt };
  }
  if (cur.count >= opts.max) {
    return { ok: false, remaining: 0, resetAt: cur.resetAt };
  }
  cur.count += 1;
  return { ok: true, remaining: opts.max - cur.count, resetAt: cur.resetAt };
}

/** Sweep expired buckets so the Map doesn't grow forever. Cheap; call
 *  whenever convenient (e.g., 1 in 100 requests). */
export function sweepRateLimit(): void {
  const now = Date.now();
  for (const [k, v] of STORE.entries()) {
    if (v.resetAt < now) STORE.delete(k);
  }
}
