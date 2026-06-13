/**
 * Platform cookie — remembers which platform the user last chose so a fresh
 * tab opens to the right place without re-prompting the picker. Cleared on
 * sign-out (Supabase clears its own cookie too).
 *
 * Values: "command_center" | "new_platform" — strict allow-list. Anything
 * else is treated as "no preference, show the picker."
 */

export const PLATFORM_COOKIE = "ppp_last_platform";

export type Platform = "command_center" | "new_platform";

export function isPlatform(v: unknown): v is Platform {
  return v === "command_center" || v === "new_platform";
}

/** 90-day expiry — long enough to feel sticky, short enough that a user
 *  who hasn't logged in in 3 months re-picks. */
export const PLATFORM_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 90;

/** Serialize for `Set-Cookie:` — used by server routes that set the choice. */
export function platformCookieSetHeader(value: Platform): string {
  return `${PLATFORM_COOKIE}=${value}; Path=/; Max-Age=${PLATFORM_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax; Secure`;
}

/** Path used by the picker page's POST. Reused by the bottom-left
 *  sidebar switcher. */
export const PLATFORM_SET_ROUTE = "/api/platform/set";
