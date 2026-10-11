import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

/**
 * Proxy (Next 16's rename of Middleware — same thing).
 *
 * 1. Keeps people signed in. Supabase access tokens last an hour; this
 *    refreshes them and writes the new cookies back on every request
 *    (lib/supabase/middleware.ts → updateSession). Server Components can't
 *    write cookies, so without this an expired token is refreshed in memory on
 *    every render and never saved — the same one-time refresh token gets
 *    reused until Supabase revokes the session, and the person is bounced to
 *    the login page, where the stale cookies also make the next sign-in fail
 *    once or twice. That is exactly what happened from 2026-08-11 (57278b1f
 *    replaced this file's updateSession call with the path stamp below and
 *    scoped it to /commercial) until this was put back.
 *
 * 2. Stamps x-pathname for the Commercial crew gate (app/commercial/layout.tsx
 *    — a layout can't see the URL). The AUTH decision for crew stays in that
 *    layout; this only reports the path, and replaces any client-sent value.
 */
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Everything except: Next's static files and images, icons/brand assets,
    // and machine endpoints that never carry a user session (payment and
    // messaging webhooks, scheduled jobs).
    "/((?!_next/static|_next/image|favicon\\.ico|manifest\\.webmanifest|brand/|api/webhooks/|api/stripe/|api/cron/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|txt|xml)$).*)",
  ],
};
