/**
 * THREE DOORS THAT OPENED FOR THE WRONG CALLER.
 *
 *   - The production Salesforce callback stored any `?code=` a PPP-domain
 *     session brought it: no `state`, no admin check. That credential is the
 *     one every snapshot read and every Tomco write-back uses.
 *   - GET /api/admin/email-test sent real branded email, so an admin's Lax
 *     cookie on one clicked link was enough to mail any address.
 *   - The cron routes compared the bearer with `!==`.
 *
 * Asserted on what the code PRODUCES — the authorize URL, the state check's
 * verdicts, the route's actual Response — not on how the source spells it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mintOAuthNonce,
  oauthStateMatches,
  PROD_STATE_PREFIX,
  readCookie,
} from "@/lib/salesforce/oauth-state";
import { SANDBOX_STATE_PREFIX } from "@/lib/salesforce/sandbox-callback";
import { getSalesforceAuthorizationUrl } from "@/lib/salesforce/client";
import { cronRequestAuthorized } from "@/lib/cron-auth";
import { EMAIL_TEST_PARAMS, emailTestConfirmPage } from "@/lib/email/email-test-page";
import { isAdminProfile } from "@/lib/auth/roles";
import { isAdminEmail } from "@/lib/auth/admin";

describe("the identity that holds the live Salesforce login passes the new admin gate", () => {
  // developer@precisionpaintingplus.net stored the production credential. The
  // login and callback now require isAdminProfile(profile, isAdminEmail(email)),
  // the same resolver as the Integrations page that holds the Connect button.
  const saved = process.env.PPP_ADMIN_EMAILS;
  afterAll(() => {
    if (saved === undefined) delete process.env.PPP_ADMIN_EMAILS;
    else process.env.PPP_ADMIN_EMAILS = saved;
  });

  it("passes on the bootstrap list, with no profile flag and no role", () => {
    delete process.env.PPP_ADMIN_EMAILS;
    for (const email of ["developer@precisionpaintingplus.net", "Developer@PrecisionPaintingPlus.net "]) {
      expect(isAdminProfile(null, isAdminEmail(email))).toBe(true);
      expect(isAdminProfile({ role: null, is_admin: false }, isAdminEmail(email))).toBe(true);
    }
  });

  it("passes on its profile alone, even off the allow-list", () => {
    process.env.PPP_ADMIN_EMAILS = "someone-else@precisionpaintingplus.net";
    expect(isAdminEmail("developer@precisionpaintingplus.net")).toBe(false);
    expect(isAdminProfile({ role: null, is_admin: true }, false)).toBe(true);
    expect(isAdminProfile({ role: "admin", is_admin: false }, false)).toBe(true);
  });

  it("is refused only if its profile ROLE says otherwise — the one case to check in production", () => {
    delete process.env.PPP_ADMIN_EMAILS;
    expect(isAdminProfile({ role: "rep", is_admin: true }, isAdminEmail("developer@precisionpaintingplus.net"))).toBe(false);
  });
});

describe("production Salesforce OAuth state", () => {
  const saved: Record<string, string | undefined> = {};
  const env = {
    SF_CONSUMER_KEY: "test-key",
    SF_CONSUMER_SECRET: "test-secret",
    SF_LOGIN_URL: "https://login.example.test",
  };
  beforeAll(() => {
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterAll(() => {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("the authorize URL carries the state the login route minted, and it round-trips", () => {
    const nonce = mintOAuthNonce();
    const url = new URL(
      getSalesforceAuthorizationUrl("https://hub.example.test/api/auth/salesforce/callback", `${PROD_STATE_PREFIX}${nonce}`),
    );
    const echoed = url.searchParams.get("state");
    expect(echoed).toBe(`${PROD_STATE_PREFIX}${nonce}`);
    expect(oauthStateMatches(echoed, PROD_STATE_PREFIX, nonce)).toBe(true);
  });

  it("a production state is never routed to the payments sandbox handler", () => {
    expect(`${PROD_STATE_PREFIX}${mintOAuthNonce()}`.startsWith(SANDBOX_STATE_PREFIX)).toBe(false);
  });

  it("refuses every way a code can arrive that did not start in this browser", () => {
    const nonce = mintOAuthNonce();
    const other = mintOAuthNonce();
    expect(nonce).not.toBe(other);
    // no state at all — the pre-fix callback's only case
    expect(oauthStateMatches(null, PROD_STATE_PREFIX, nonce)).toBe(false);
    // state present, cookie missing (a crafted link opened in a fresh session)
    expect(oauthStateMatches(`${PROD_STATE_PREFIX}${nonce}`, PROD_STATE_PREFIX, null)).toBe(false);
    // someone else's nonce
    expect(oauthStateMatches(`${PROD_STATE_PREFIX}${other}`, PROD_STATE_PREFIX, nonce)).toBe(false);
    // right nonce, wrong prefix (the sandbox flow's state)
    expect(oauthStateMatches(`${SANDBOX_STATE_PREFIX}${nonce}`, PROD_STATE_PREFIX, nonce)).toBe(false);
    // a prefix with nothing after it against an empty cookie
    expect(oauthStateMatches(PROD_STATE_PREFIX, PROD_STATE_PREFIX, "")).toBe(false);
    // a longer value that merely starts with the nonce
    expect(oauthStateMatches(`${PROD_STATE_PREFIX}${nonce}x`, PROD_STATE_PREFIX, nonce)).toBe(false);
  });

  it("reads the nonce cookie by exact name out of a real Cookie header", () => {
    const header = "sb-access=abc; ppp_sf_prod_state_old=nope; ppp_sf_prod_state=N0nce-_x; theme=dark";
    expect(readCookie(header, "ppp_sf_prod_state")).toBe("N0nce-_x");
    expect(readCookie(header, "missing")).toBeNull();
    expect(readCookie(null, "ppp_sf_prod_state")).toBeNull();
  });
});

describe("cron bearer check", () => {
  it("accepts exactly Vercel's header and nothing else", () => {
    const secret = "s3cret-value";
    expect(cronRequestAuthorized(`Bearer ${secret}`, secret)).toBe(true);
    expect(cronRequestAuthorized(`Bearer ${secret}x`, secret)).toBe(false);
    expect(cronRequestAuthorized(`Bearer ${secret.slice(0, -1)}`, secret)).toBe(false);
    expect(cronRequestAuthorized(secret, secret)).toBe(false);
    expect(cronRequestAuthorized(null, secret)).toBe(false);
  });

  it("fails closed when the secret is unset — even for `Bearer ` and `Bearer undefined`", () => {
    for (const unset of [undefined, null, ""]) {
      expect(cronRequestAuthorized("Bearer ", unset)).toBe(false);
      expect(cronRequestAuthorized("Bearer undefined", unset)).toBe(false);
      expect(cronRequestAuthorized("Bearer null", unset)).toBe(false);
    }
  });
});

describe("the routes themselves answer correctly before doing any work", () => {
  const savedSecret = process.env.CRON_SECRET;
  afterAll(() => {
    if (savedSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = savedSecret;
  });

  const CRONS: Record<string, () => Promise<{ GET: (r: Request) => Promise<Response> }>> = {
    "commercial-daily": () => import("@/app/api/cron/commercial-daily/route"),
    "tomco-writeback": () => import("@/app/api/cron/tomco-writeback/route"),
  };
  for (const [name, load] of Object.entries(CRONS)) {
    it(`/api/cron/${name} refuses a wrong bearer, a missing one, and an unset secret`, async () => {
      const mod = await load();
      const req = (auth?: string) =>
        new Request(`https://hub.example.test/api/cron/${name}`, auth ? { headers: { authorization: auth } } : {});
      process.env.CRON_SECRET = "the-real-secret";
      expect((await mod.GET(req("Bearer the-real-secreT"))).status).toBe(401);
      expect((await mod.GET(req())).status).toBe(401);
      delete process.env.CRON_SECRET;
      const unset = await mod.GET(req("Bearer undefined"));
      expect(unset.status).toBeGreaterThanOrEqual(401);
      expect(unset.status).not.toBe(500);
    });
  }

  it("GET /api/admin/email-test renders a confirm page whose button POSTs every parameter", () => {
    const html = emailTestConfirmPage(
      new URLSearchParams({ to: "karan@example.com", kind: "confirmation", name: '"><script>x</script>' }),
    );
    const forms = [...html.matchAll(/<form\b([^>]*)>/g)].map((m) => m[1]);
    expect(forms).toHaveLength(1);
    expect(forms[0]).toMatch(/method="post"/);
    expect(forms[0]).toMatch(/action="\/api\/admin\/email-test"/);
    // every field the POST reads is a field on the page, and nothing else submits
    const names = [...html.matchAll(/<(?:input|select|textarea)\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1]).sort();
    expect(names).toEqual([...EMAIL_TEST_PARAMS].sort());
    // the bookmark's values arrive filled in, and cannot break out of the attribute
    expect(html).toContain('value="karan@example.com"');
    expect(html).toMatch(/<option value="confirmation" selected>/);
    expect(html).not.toContain("<script");
  });

  it("the confirm page is behind the admin gate, like the send", async () => {
    // GET reads the session before rendering; with no request scope that read
    // throws rather than falling through to the page.
    const mod = await import("@/app/api/admin/email-test/route");
    await expect(mod.GET(new Request("https://hub.example.test/api/admin/email-test?to=a@b.co"))).rejects.toThrow();
  });

  it("a cross-site POST to /api/admin/email-test is refused before the session is read", async () => {
    const mod = await import("@/app/api/admin/email-test/route");
    const res = await mod.POST(
      new Request("https://hub.example.test/api/admin/email-test?to=victim@example.com", {
        method: "POST",
        headers: { origin: "https://evil.example.test" },
      }),
    );
    expect(res.status).toBe(403);
  });
});
