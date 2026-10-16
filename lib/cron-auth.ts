import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Does this request carry Vercel cron's `Authorization: Bearer <CRON_SECRET>`?
 *
 * The routes compared with `!==`, which returns at the first differing byte, so
 * how long a refusal took said how much of a guessed secret was right. Both
 * sides are hashed to a fixed 32 bytes first, so timingSafeEqual neither throws
 * on a length mismatch nor leaks the secret's length through an early return.
 *
 * FAILS CLOSED: an unset or empty secret authorises nothing, including a
 * request that sends `Bearer ` with nothing after it.
 */
export function cronRequestAuthorized(
  authorization: string | null | undefined,
  secret: string | null | undefined,
): boolean {
  if (!secret || !authorization) return false;
  const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`));
}
