import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A link in an email has an origin, or it is not a link.
 *
 * `appendBase` used to prepend `process.env.NEXT_PUBLIC_APP_URL || ""`. With
 * that env unset it returned the path unchanged — and the path goes straight
 * into every notification email's button:
 *
 *     <a href="/commercial/invoices/<id>">Open the invoice →</a>
 *
 * A mail client has no origin to resolve that against, so it is a DEAD link,
 * not a wrong one, on every notification kind at once. Nothing errors, nothing
 * logs, and the email looks perfectly fine in the send log.
 *
 * Two things make it the kind of bug that survives:
 *   · it is invisible anywhere the env IS set, which is every environment
 *     anyone tests in;
 *   · the Slack half of the same file already handles it correctly — it drops
 *     the button when the URL is not absolute — so a reader comparing the two
 *     would reasonably assume email was covered too.
 *
 * It also broke List-Unsubscribe, which must be an absolute URI. Gmail ignores
 * a malformed one, which removes the one-click unsubscribe that header exists
 * to provide — and its absence is read as a spam signal, which is the exact
 * deliverability complaint it was added for.
 */

const src = readFileSync(
  join(process.cwd(), "lib/notifications/commercial-events.ts"),
  "utf8"
);

describe("email links", () => {
  it("never USES an unvalidated origin", () => {
    /**
     * Asserting `!/NEXT_PUBLIC_APP_URL \|\| ""/` was too blunt and went red on
     * the fix itself: reading the env with `|| ""` is fine when what follows is
     * a scheme check, and is the bug when the result is used directly. The
     * distinction is what happens NEXT, so that is what this checks.
     */
    const base = src.slice(src.indexOf("function appBase()"), src.indexOf("function appendBase"));
    // Inside appBase: read it, then prove it is absolute before trusting it.
    expect(base).toContain("NEXT_PUBLIC_APP_URL");
    expect(base).toMatch(/test\(configured\)/);
    expect(base).toContain("return APP_ORIGIN_FALLBACK");
    // And appendBase must not read the env itself — one place decides.
    const append = src.slice(src.indexOf("function appendBase"), src.indexOf("function appendBase") + 200);
    expect(append).not.toContain("NEXT_PUBLIC_APP_URL");
    expect(append).toContain("appBase()");
  });

  it("fall back to an absolute origin instead", () => {
    expect(src).toMatch(/APP_ORIGIN_FALLBACK\s*=\s*"https:\/\//);
    // And only accept a configured value that is itself absolute — a
    // half-typed "hub.precisionpaintingplus.net" with no scheme is the same
    // dead link wearing a different hat.
    expect(src).toContain("https?:");
  });

  it("builds the unsubscribe URL through the same helper", () => {
    // If this ever stops going through appendBase, the header silently goes
    // back to being a relative path and Gmail drops the unsubscribe button.
    expect(src).toContain('appendBase("/commercial/settings/notifications")');
    expect(src).toContain('"List-Unsubscribe-Post": "List-Unsubscribe=One-Click"');
  });

  it("still prefers the configured origin when there is one", () => {
    // The fallback is a safety net, not a hard-coded host — a preview or a
    // renamed domain must still win.
    const fn = src.slice(src.indexOf("function appBase()"), src.indexOf("function appendBase"));
    expect(fn).toContain("NEXT_PUBLIC_APP_URL");
    expect(fn.indexOf("configured")).toBeLessThan(fn.indexOf("APP_ORIGIN_FALLBACK"));
  });
});
