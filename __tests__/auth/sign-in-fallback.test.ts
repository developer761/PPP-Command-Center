import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const page = readFileSync(join(root, "app/page.tsx"), "utf8");

/**
 * Every sign-in failure names a way IN, not just the way it failed.
 *
 * Checked the night before the 2026-10-07 rollout: 25 active field reps in
 * Salesforce, 24 with no Command Center account, all expected to make one by
 * signing in with Google. That only works if PPP IT has issued them a Google
 * Workspace account on the PPP domain, which nothing in this app can see.
 *
 * A rep who has a Salesforce user but no Workspace account signs in with a
 * personal Gmail, lands on `domain_not_allowed`, and used to read "sign in
 * with your PPP account" — advice they cannot take, with no mention of the
 * email-and-password box directly beneath the button they just pressed.
 */
describe("a refused sign-in points at the other route", () => {
  /** The error map, brace-matched so this reads the real object. */
  const copy = (() => {
    const start = page.indexOf("const ERROR_COPY");
    const open = page.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < page.length; i++) {
      if (page[i] === "{") depth++;
      else if (page[i] === "}") { depth--; if (depth === 0) return page.slice(open, i + 1); }
    }
    throw new Error("ERROR_COPY not found");
  })();

  const CODES = ["domain_not_allowed", "oauth_failed", "no_code", "no_sf_user", "sf_user_inactive"];

  it("covers every failure the callback can redirect with", () => {
    for (const c of CODES) expect(copy, c).toContain(`${c}:`);
    // …and the callback does not emit a code this map has never heard of.
    const callback = readFileSync(join(root, "app/auth/callback/route.ts"), "utf8");
    for (const m of callback.matchAll(/\?error=([a-z_]+)/g)) {
      expect(copy, `callback emits ?error=${m[1]}`).toContain(`${m[1]}:`);
    }
  });

  /**
   * ONE message, not a fixed-width window.
   *
   * The first version sliced 420 characters from the key, which ran past the
   * end of the string and into the NEXT entry — so an assertion about
   * `domain_not_allowed` was satisfied by text belonging to `oauth_failed`.
   * Deleting the clause under test left the suite green (mutation-checked
   * 2026-10-06). This reads the quoted value and stops at it.
   */
  function messageFor(code: string): string {
    const at = copy.indexOf(`${code}:`);
    expect(at, `${code} missing`).toBeGreaterThan(-1);
    const rest = copy.slice(at + code.length + 1);
    const m = rest.match(/\s*"((?:[^"\\]|\\.)*)"/);
    expect(m, `${code} has no quoted message`).not.toBeNull();
    return m![1];
  }

  it("names the email-and-password fallback on every recoverable one", () => {
    // access_revoked is deliberately excluded: another route will not help, and
    // saying so is the honest answer there.
    for (const c of CODES) {
      expect(messageFor(c).toLowerCase(), c).toMatch(/email and password|email & password/);
    }
  });

  it("reads one message at a time — the windows do not overlap", () => {
    // Guards the guard above. If messageFor bleeds into its neighbour again,
    // these stop being distinguishable.
    //
    // FOUR distinct texts for five codes, not five: no_sf_user and
    // sf_user_inactive are deliberately identical — Kate, 2026-08-31, "both
    // cases mean the same thing to the person standing there". Asserting five
    // was my own wrong expectation, and this is the shape that is actually
    // true.
    const all = CODES.map(messageFor);
    expect(new Set(all).size).toBe(4);
    expect(messageFor("no_sf_user")).toBe(messageFor("sf_user_inactive"));
    // No message has swallowed a neighbouring KEY, which is what overlap looks
    // like when it happens.
    for (const m of all) for (const c of CODES) expect(m).not.toContain(`${c}:`);
  });

  it("tells a revoked account that another route will NOT work", () => {
    const msg = messageFor("access_revoked");
    expect(msg).toMatch(/won't get you back in|switch it on again/);
    // …and it does NOT dangle the fallback, which would be false comfort.
    expect(msg.toLowerCase()).not.toMatch(/ask an admin for an email and password/);
  });

  it("still offers that fallback control on the page", () => {
    // The copy points at a box; the box has to be there.
    expect(page).toMatch(/<EmailPasswordSignIn \/>/);
  });
});

/**
 * And the bulk fallback, for if Google turns out not to work for a batch.
 */
describe("the bulk provisioning fallback is safe by default", () => {
  const script = readFileSync(join(root, "scripts/provision-field-reps.mjs"), "utf8");

  it("writes nothing without --commit", () => {
    expect(script).toMatch(/const COMMIT = argv\.includes\("--commit"\)/);
    expect(script).toMatch(/DRY RUN — nothing was written/);
    // The dry-run branch exits BEFORE any create call.
    expect(script.indexOf("DRY RUN — nothing was written")).toBeLessThan(script.indexOf("await createPasswordUser"));
  });

  it("can only ever create an active PPP-domain Salesforce rep", () => {
    expect(script).toMatch(/IsActive = true AND Profile\.Name LIKE '%Standard\.Field%'/);
    expect(script).toMatch(/@precisionpaintingplus\\\.\(com\|net\)\$/);
  });

  it("never grants admin", () => {
    expect(script).toMatch(/role: "rep"/);
    expect(script).not.toMatch(/role: "admin"/);
  });

  it("goes through the audited create, not a raw insert", () => {
    expect(script).toMatch(/createPasswordUser/);
    expect(script).not.toMatch(/from\("profiles"\)\s*\.insert/);
  });

  it("skips anyone who already has an account, on either domain spelling", () => {
    expect(script).toMatch(/already has an account/);
    expect(script).toMatch(/otherDomain/);
  });
});
