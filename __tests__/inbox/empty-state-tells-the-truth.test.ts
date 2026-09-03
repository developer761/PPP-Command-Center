import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Mail inbox sat empty for weeks printing "Once Resend inbound is
 * configured…" plus three setup steps — while PPP had already done all three.
 * The webhook was returning 500 to every delivery, so a DEAD integration read
 * as an UNBUILT one, and the empty state actively sent Karan to redo finished
 * work.
 *
 * An empty state that states a cause has to know the cause. This pins the two
 * halves: the server reports whether receiving is wired, and the component
 * branches on it — with the setup steps reachable ONLY when it is not.
 */
const ROOT = join(__dirname, "..", "..");
const api = readFileSync(join(ROOT, "app/api/admin/inbox/route.ts"), "utf8");
const view = readFileSync(join(ROOT, "components/inbox-view.tsx"), "utf8");

describe("the inbox empty state distinguishes 'not set up' from 'nothing yet'", () => {
  it("the API reports whether inbound is wired", () => {
    expect(api).toMatch(/inboundConfigured:\s*Boolean\(process\.env\.RESEND_INBOUND_SECRET\?\.trim\(\)\)/);
  });

  it("it reports a BOOLEAN and never the secret itself", () => {
    // A webhook secret in a browser payload would be a real leak.
    expect(api).not.toMatch(/RESEND_INBOUND_SECRET\s*[,}]/);
    expect(api).not.toMatch(/secret:\s*process\.env\.RESEND_INBOUND_SECRET/);
  });

  it("the setup steps render only when inbound is NOT configured", () => {
    const stepsAt = view.indexOf("Setup steps:");
    expect(stepsAt).toBeGreaterThan(-1);
    // The steps must sit inside the NEGATIVE branch of the flag.
    const branchAt = view.indexOf("{inboundConfigured ? (");
    expect(branchAt).toBeGreaterThan(-1);
    // Bound the positive branch at the ternary's else marker — slicing all the
    // way to the steps spans BOTH branches and the assertion passes/fails for
    // the wrong reason (it did, on the first run).
    const elseAt = view.indexOf(") : (", branchAt);
    expect(elseAt).toBeGreaterThan(branchAt);
    expect(stepsAt).toBeGreaterThan(elseAt);
    const positive = view.slice(branchAt, elseAt);
    expect(positive).not.toMatch(/Once Resend inbound is configured/);
    expect(positive).not.toMatch(/Setup steps/);
    expect(positive).toMatch(/Receiving is on/);
  });

  it("defaults to the setup steps when the API is older than the UI", () => {
    // A deploy where the component ships before the route must not claim
    // receiving works — absence of the flag means "unknown", not "yes".
    expect(view).toMatch(/inboundConfigured = false/);
    expect(view).toMatch(/summary\.inboundConfigured \?\? false/);
  });
});
