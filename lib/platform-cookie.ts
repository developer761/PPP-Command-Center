/**
 * Platform cookie — remembers which platform the user last chose so a fresh
 * tab opens to the right place without re-prompting the picker. Cleared on
 * sign-out (Supabase clears its own cookie too).
 *
 * Values: "command_center" | "new_platform" — strict allow-list. Anything
 * else is treated as "no preference, show the picker."
 */

export const PLATFORM_COOKIE = "ppp_last_platform";

export type Platform = "command_center" | "new_platform" | "messaging";

export function isPlatform(v: unknown): v is Platform {
  return v === "command_center" || v === "new_platform" || v === "messaging";
}

/** Every platform, in the order the picker and switcher list them. Adding a
 *  platform means adding it here and to the three records below — the compiler
 *  then points at anything else that needs updating. */
export const ALL_PLATFORMS: readonly Platform[] = ["command_center", "new_platform", "messaging"] as const;

/** User-facing names. The internal slug stays `new_platform` (DB column +
 *  cookie value); only the label reads "Commercial" (Karan 2026-06-13). */
export const PLATFORM_LABEL: Record<Platform, string> = {
  command_center: "PPP Command Center",
  new_platform: "Commercial Command Center",
  messaging: "Messaging",
};

/** Where each platform opens. The residential home is role-aware at the
 *  picker (see homeHrefFor); this flat value is the safe default. */
export const PLATFORM_HOME: Record<Platform, string> = {
  command_center: "/dashboard",
  new_platform: "/commercial",
  messaging: "/messaging",
};

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
