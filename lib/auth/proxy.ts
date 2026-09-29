import "server-only";

import { cookies } from "next/headers";

/**
 * Proxy login — "log in as" another user, the way Salesforce does it.
 *
 * Katie, 2026-09-29: "all admins under settings we can have a proxy tab and be
 * able to log in as them and see their view." The case that prompted it: Jason
 * hit a problem in the paint tool and took no screenshots, so somebody needs
 * to stand where he was standing.
 *
 * WHY THIS IS NOT "View As". View As (2026-05) narrows which work orders an
 * admin SEES while leaving them an admin — same menus, same buttons, same
 * capabilities. It reproduces a data problem and cannot reproduce a
 * permissions one: if Jason's issue is a control he does not have, an admin
 * viewing as Jason still sees their own. Proxy replaces WHO YOU ARE for the
 * length of the session.
 *
 * WHAT IT DOES AND DOES NOT CHANGE
 *
 *   · Changed: the profile every part of the app reads — role, capabilities,
 *     Salesforce mapping, name. The UI, the data scope and the API routes all
 *     follow, because they all read the same profile (see getProfileByUserId).
 *   · NOT changed: the Supabase session. Writes still record the real admin's
 *     user id, and row-level security still sees them. That is deliberate and
 *     it is where this differs from Salesforce, which files the record under
 *     the person you logged in as. A record nobody can attribute is worse than
 *     a record filed under the person who actually made it, and the audit row
 *     ties the two together.
 *
 * Only an admin can start one, checked against their OWN profile with the
 * proxy explicitly ignored — otherwise a proxy into an admin would be enough
 * to keep proxying, and a proxy into a rep could never be undone.
 */
export const PROXY_COOKIE = "ppp_proxy_user";

/** The user id an admin is currently proxying, or null. Raw cookie read — the
 *  admin check lives in `resolveProxyTarget`, which is what callers use. */
export async function readProxyCookie(): Promise<string | null> {
  try {
    const jar = await cookies();
    const raw = jar.get(PROXY_COOKIE)?.value?.trim();
    return raw ? raw : null;
  } catch {
    // `cookies()` throws outside a request scope (a script, a build-time
    // render). No request means no proxy.
    return null;
  }
}

/** Cookie options shared by the set and clear paths, so they cannot drift and
 *  leave a cookie that can be read but never removed. */
export const PROXY_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  // Session-length. A proxy that outlives the browser is one somebody forgets
  // they are in, and every action afterwards is taken as the wrong person.
  maxAge: undefined,
};
