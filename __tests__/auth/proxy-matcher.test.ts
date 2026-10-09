import { describe, expect, it } from "vitest";
import { config } from "@/proxy";

/**
 * The session-refresh proxy must run on every page and every signed-in API
 * call — when it didn't (2026-08-11 → 10-08) Supabase sessions expired after
 * an hour and couldn't be refreshed, so people were bounced to the login page
 * and the next Google sign-in failed once or twice. It must NOT run on
 * machine endpoints (payment / messaging webhooks, crons) or static files.
 *
 * Next compiles the matcher like this regex (anchored, path only).
 */
const matches = (path: string) => config.matcher.some((m) => new RegExp(`^${m}$`).test(path));

describe("proxy matcher — the session refresh runs where people are signed in", () => {
  it.each([
    "/",
    "/dashboard",
    "/dashboard/payments",
    "/choose-platform",
    "/commercial/opportunities/abc",
    "/commercial/crew",
    "/api/admin/wo-debug",
    "/api/v1/anything",
    "/auth/callback",
    "/pay/abc123",
  ])("runs on %s", (p) => expect(matches(p)).toBe(true));

  it.each([
    "/api/stripe/webhook",
    "/api/webhooks/twilio-inbound",
    "/api/webhooks/resend-events",
    "/api/cron/warm-snapshot",
    "/api/cron/payment-links",
    "/_next/static/chunks/main.js",
    "/_next/image",
    "/favicon.ico",
    "/brand/logo.svg",
    "/manifest.webmanifest",
    "/some/photo.png",
  ])("skips %s", (p) => expect(matches(p)).toBe(false));
});
