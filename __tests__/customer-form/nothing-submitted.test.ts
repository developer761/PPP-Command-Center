import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const route = readFileSync(join(root, "app/api/customer-form/submit/[token]/route.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/.*$/gm, "$1 ");

/**
 * An empty submission used to look like a successful one.
 *
 * Submitting an untouched form marked the token submitted, flipped the work
 * order to "Ready to order", and showed "Thanks — we've got your color picks!"
 * — while sending no receipt, notifying nobody, and writing nothing to
 * Salesforce. The job then sat in the ready queue containing nothing, and the
 * customer believed they were done.
 */
describe("a submission with nothing in it is refused", () => {
  it("checks BEFORE the token is marked submitted", () => {
    // Order matters more than the check existing. Once markSubmitted runs the
    // link reads as used and the status has already moved, so a refusal after
    // it would leave exactly the broken state it is meant to prevent.
    const guard = route.indexOf("nothing_submitted");
    const mark = route.indexOf("markSubmitted(tokenFromUrl");
    expect(guard).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(mark);
  });

  it("refuses with a 400 that says what to do", () => {
    expect(route).toMatch(/status: 400/);
    expect(route).toMatch(/Pick a color for at least one surface/);
  });

  it("counts a skipped surface as an answer", () => {
    // "Don't paint the ceiling" is a decision, not a blank. Refusing it would
    // block a customer who has told us something real.
    expect(route).toMatch(/s\.skipped === true/);
  });

  it("counts notes on their own as an answer", () => {
    // A customer who writes "I'll call you about colors" has submitted
    // something; that path already has handling all the way through.
    expect(route).toMatch(/wroteNotes/);
    expect(route).toMatch(/!pickedSomething && !wroteNotes/);
  });
});

/**
 * `sendEmail` RETURNS {ok:false}; it does not throw. The receipt was fired
 * with a bare .catch(), which could never see a refused send — so a customer
 * got no confirmation and PPP never found out.
 */
describe("a receipt that does not send is reported", () => {
  it("reads the RESULT, not just the rejection", () => {
    expect(route).toMatch(/\.then\(\(res\)/);
    expect(route).toMatch(/if \(!res\?\.ok\)/);
    expect(route).toMatch(/receipt NOT SENT/);
  });

  it("still catches a thrown error separately", () => {
    expect(route).toMatch(/receipt threw for token/);
  });

  it("uses the validated recipient helper that nothing called", () => {
    // receiptRecipient refuses to fall back to the staff address on an
    // internal token. It existed; the route passed customer_email raw.
    expect(route).toMatch(/receiptRecipient\(\{/);
    expect(route).toMatch(/to: recipient\.email/);
  });

  it("says so when there is no address to send to", () => {
    // The colors landed, the customer just cannot be told. Silence here is
    // what made this class invisible in the first place.
    expect(route).toMatch(/no usable receipt address/);
  });

  it("CCs the estimator so a reply reaches a person", () => {
    expect(route).toMatch(/senderEmail: senderIdentity\?\.email/);
    expect(route).toMatch(/senderName: senderIdentity\?\.name/);
  });

  it("falls back to the request origin for the edit button", () => {
    // NEXT_PUBLIC_APP_URL unset made the receipt's one button a dead relative
    // href. Every sibling route already falls back this way.
    expect(route).toMatch(/NEXT_PUBLIC_APP_URL \|\| new URL\(request\.url\)\.origin/);
  });
});

describe("a re-edit is exempt, because an empty one is an instruction", () => {
  it("lets a re-edit through so a removed color can be cleared", () => {
    // A customer who presses "Change" and does not re-pick sends an empty
    // payload on purpose. The re-edit payload is the current answer for every
    // surface it carries, so Salesforce has to be cleared to match — refusing
    // it leaves the crew painting a color the customer deleted.
    //
    // submit-route-writes.test.ts caught the first version of the guard
    // reintroducing exactly that.
    expect(route).toMatch(/!isReedit && !pickedSomething && !wroteNotes/);
  });

  it("and the exemption is narrow — a first submit is still refused", () => {
    // The guard still fires on the path that created the problem: an
    // untouched FIRST submission.
    const guard = route.slice(route.indexOf("pickedSomething"), route.indexOf("nothing_submitted"));
    expect(guard).toMatch(/isReedit/);
    expect(route).toMatch(/nothing_submitted/);
  });
});
