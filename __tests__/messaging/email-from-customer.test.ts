import { describe, it, expect } from "vitest";
import { emailFromCustomer } from "@/lib/messaging/email-from-customer";
import { knownFromThread } from "@/lib/messaging/known-from-thread";

/**
 * The bot asks "Can I grab your name and email for the quote?", the customer
 * answers, and until 2026-09-28 nothing kept the answer: customer_email was
 * written once at enrolment and never again.
 *
 * The third field with that hole, after inquiry_scope and customer_address,
 * and the one that costs the most — on the off-site route the quote is SENT
 * to this column (`toEmail: data.customer_email`). So the bot collected the
 * one thing the route needs and dropped it.
 *
 * Which is also why this parser refuses where the address parser guesses: a
 * wrong address is a bad record, a wrong email is a message to a stranger.
 */
describe("reading an email out of what the customer typed", () => {
  it("takes the one they gave", () => {
    expect(emailFromCustomer("Tom Smith, tom@example.com")).toBe("tom@example.com");
  });

  it("normalises case, because a phone keyboard capitalises", () => {
    expect(emailFromCustomer("TOM@EXAMPLE.COM")).toBe("tom@example.com");
  });

  it("keeps the parts of an address that are not decoration", () => {
    expect(emailFromCustomer("tom.smith+quotes@sub.example.co.uk"))
      .toBe("tom.smith+quotes@sub.example.co.uk");
  });

  it("refuses two different addresses rather than picking one", () => {
    // "mine's tom@ but send it to my wife jan@" has no single answer. Which
    // one is a judgement about who the customer is; a person makes it.
    expect(emailFromCustomer("mine is tom@a.com but send it to jan@b.com")).toBeNull();
  });

  it("counts the same address twice as once", () => {
    expect(emailFromCustomer("tom@example.com, that's tom@example.com"))
      .toBe("tom@example.com");
  });

  it("does not read OUR address as theirs", () => {
    // Naming our address is not giving us theirs, and storing it would make
    // the system send the quote to itself.
    expect(emailFromCustomer("should I email you at info@precisionpaintingplus.net?"))
      .toBeNull();
  });

  it("still finds theirs in a message that also names ours", () => {
    expect(
      emailFromCustomer("do I email info@precisionpaintingplus.net? mine is tom@example.com")
    ).toBe("tom@example.com");
  });

  it("takes an extra domain the caller says is ours", () => {
    expect(emailFromCustomer("quotes@ppp-mail.com", { ours: ["hello@ppp-mail.com"] }))
      .toBeNull();
  });

  it.each([
    ["no email, just text me"],
    ["its tom at example dot com"],
    ["my address is 12 Oak St, Garden City NY 11530"],
    [""],
  ])("finds nothing in %j", (text) => {
    expect(emailFromCustomer(text)).toBeNull();
  });
});

describe("the email the thread knows", () => {
  const thread = (body: string, onFile: { email?: string | null } = {}) =>
    knownFromThread({ onFile, messages: [{ body }], stage: 0 });

  it("reads one the customer typed, and says it came from the chat", () => {
    const r = thread("Tom Smith, tom@example.com");
    expect(r.email).toBe("tom@example.com");
    expect(r.emailFromChat).toBe(true);
  });

  it("never overwrites what the office holds", () => {
    // The record is the office's version. Same rule as the scope and the
    // address, and the reason both are guarded on the column being empty.
    const r = thread("actually use tom@example.com", { email: "office@onfile.com" });
    expect(r.email).toBe("office@onfile.com");
    expect(r.emailFromChat).toBe(false);
  });

  it("treats a cleared column as absent, not as a value", () => {
    // A text column somebody edited and cleared holds " ", not NULL. The
    // address path had exactly this bug: it scanned the thread, found the
    // value, then returned "" anyway.
    const r = thread("tom@example.com", { email: "   " });
    expect(r.email).toBe("tom@example.com");
    expect(r.emailFromChat).toBe(true);
  });

  it("does not read our own sentence back as their answer", () => {
    // A reaction arrives as `Liked "<our message>"`. normalizeInbound strips
    // it, so there are no words of theirs to scan.
    const r = thread('Liked "Can I grab your name and email for the quote?"');
    expect(r.email).toBeNull();
    expect(r.emailFromChat).toBe(false);
  });

  it("holds nothing when they gave nothing", () => {
    const r = thread("sounds good");
    expect(r.email).toBeNull();
    expect(r.emailFromChat).toBe(false);
  });
});

/**
 * PPP HAS TWO DOMAINS AND THIS KNEW ONE.
 *
 * lib/brand.ts carries the website, which is the .net. lib/auth/admin.ts has
 * had BOTH on its sign-in allow-list since the start, with a
 * crossDomainEmailVariant helper whose entire job is that kate@ppp.net and
 * kate@ppp.com are the same company. Only the .net was excluded here.
 *
 * Found by a detector written to answer "how do we keep missing simple
 * things": it looks for an option a function offers that nothing ever passes.
 * `ours` — the hook for supplying more of our own domains — was declared,
 * covered by a test, and never supplied by production. The same shape as the
 * availability flag that made a conversation unclosable: a capability the
 * product did not actually have.
 */
describe("one of PPP's own addresses is never the customer's", () => {
  it("does not hand back the .com when that is all they named", () => {
    // This was returned as the customer's email, written to customer_email,
    // and the quote would have been sent to PPP instead of to them.
    expect(emailFromCustomer("just send it to estimates@precisionpaintingplus.com")).toBeNull();
  });

  it("finds theirs when they name ours alongside it", () => {
    // Two addresses survived the filter, so it refused and returned nothing —
    // and the bot asked again for what they had just given.
    expect(emailFromCustomer("your estimates@precisionpaintingplus.com never replied, mine is tom@example.com"))
      .toBe("tom@example.com");
  });

  it("still excludes the .net, which always worked", () => {
    expect(emailFromCustomer("not info@precisionpaintingplus.net, use tom@example.com"))
      .toBe("tom@example.com");
  });

  it("leaves a customer on an unrelated domain alone", () => {
    expect(emailFromCustomer("tom@precisionpainting.com")).toBe("tom@precisionpainting.com");
  });
});
