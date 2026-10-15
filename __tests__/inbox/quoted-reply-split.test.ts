/**
 * The cut between a reply and the thread it is answering.
 *
 * Both the bell preview and the Mail Hub thread depend on this one function,
 * so the bodies below are the real ones Kate sent on 2026-10-14 rather than
 * invented samples — the first vendor replies the hub ever displayed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitQuotedReply } from "@/lib/email/quoted-reply";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

/** Verbatim, nested quoting and wrapped attribution included. */
const KATES_REPLY = [
  'Hitting "reply" not "reply all" as a test. I am the vendor',
  "",
  "On Wed, Oct 14, 2026 at 11:22 AM PPP Support <",
  "support@precisionpaintingplus.net> wrote:",
  "",
  '> Hitting "reply" not "reply all" as a test',
  ">",
  "> On Wed, Oct 14, 2026 at 11:22 AM Precision Painting Plus <",
  "> orders@orders.precisionpaintingplus.net> wrote:",
  ">",
  ">> Hi there,",
  ">>",
  ">> PO Number: 00318897-2",
  ">>   3 gal — Regal Select INT — OC-17 White Dove · Semi-Gloss",
].join("\n");

describe("splitting a reply from its quote", () => {
  it("keeps only what the vendor wrote", () => {
    expect(splitQuotedReply(KATES_REPLY).reply.trim()).toBe(
      'Hitting "reply" not "reply all" as a test. I am the vendor'
    );
  });

  it("KEEPS the quote rather than discarding it", () => {
    // A vendor who answers inline ("out of stock until Thursday") puts the
    // information inside the quote. Tidying it away would lose the message.
    const { quoted } = splitQuotedReply(KATES_REPLY);
    expect(quoted).toContain("OC-17 White Dove");
    expect(quoted).toContain("PO Number: 00318897-2");
  });

  it("loses not one character of the body", () => {
    // reply + quoted must reconstitute the original exactly. Anything else
    // means the fold is quietly eating text.
    const { reply, quoted } = splitQuotedReply(KATES_REPLY);
    expect(reply + quoted).toBe(KATES_REPLY);
  });

  it("cuts at an attribution Gmail wrapped across two lines", () => {
    // The "wrote:" is on the line after the "On" in Kate's real message —
    // a line-by-line rule could never have matched it.
    const { reply } = splitQuotedReply(KATES_REPLY);
    expect(reply).not.toContain("wrote:");
    expect(reply).not.toContain("support@precisionpaintingplus.net");
  });

  it("cuts at Outlook's separator", () => {
    const { reply, quoted } = splitQuotedReply(
      "We have it in stock.\n\n-----Original Message-----\nFrom: PPP"
    );
    expect(reply.trim()).toBe("We have it in stock.");
    expect(quoted).toContain("From: PPP");
  });

  it("does not fire on ordinary prose containing 'on'", () => {
    const body = "On Friday we can deliver the Revere Pewter.";
    expect(splitQuotedReply(body)).toEqual({ reply: body, quoted: "" });
  });

  it("never cuts inside a WORD containing 'on'", () => {
    // Kate's FU.13, verbatim. The newline before "On" was optional, so with
    // the /i flag this matched the "on " inside "k.sutton" and the hub
    // showed "...I'm the vendor, k.sutt" with "on is the sender" folded
    // away as someone else's quoted email.
    const body =
      'Hitting "Reply All" as a test -- I\'m the vendor, k.sutton is the sender\n' +
      "\n" +
      "On Wed, Oct 14, 2026 at 11:24 AM Precision Painting Plus <\n" +
      "orders@orders.precisionpaintingplus.net> wrote:\n" +
      "> Hi there,";
    const { reply, quoted } = splitQuotedReply(body);
    expect(reply.trim()).toBe(
      'Hitting "Reply All" as a test -- I\'m the vendor, k.sutton is the sender'
    );
    expect(reply).toContain("k.sutton is the sender");
    expect(quoted).toContain("Precision Painting Plus");
  });

  it("still cuts an attribution sitting behind quote markers", () => {
    // Nested replies indent the attribution with '>' before the "On".
    const { reply } = splitQuotedReply(
      "Confirmed.\n\n> On Wed, Oct 14, 2026 at 11:24 AM PPP wrote:\n>> order"
    );
    expect(reply.trim()).toBe("Confirmed.");
  });

  it("cuts an attribution that opens the body with no preceding newline", () => {
    // Anchoring to line start must still allow the very first character.
    const { reply, quoted } = splitQuotedReply(
      "On Wed, Oct 14, 2026 at 11:24 AM PPP wrote:\n> order"
    );
    expect(reply.trim()).toBe("");
    expect(quoted).toContain("PPP wrote:");
  });

  it("reports an EMPTY reply when the person wrote below the quote", () => {
    // Not a failure — the caller decides. The thread view shows the whole
    // body in this case rather than folding a message out of sight.
    const { reply, quoted } = splitQuotedReply(
      "On Mon, Oct 13, 2026 at 9:02 AM PPP wrote:\n> order\n\nYes, confirmed."
    );
    expect(reply.trim()).toBe("");
    expect(quoted).toContain("Yes, confirmed.");
  });

  it("is empty, not crashy, for nothing", () => {
    expect(splitQuotedReply(null)).toEqual({ reply: "", quoted: "" });
    expect(splitQuotedReply("")).toEqual({ reply: "", quoted: "" });
  });

  it("normalizes the CRLF that actually arrives over SMTP", () => {
    // The line breaks INSIDE the reply are the ones that matter. A carriage
    // return sitting immediately before the attribution gets swallowed by the
    // cut either way, so a one-line reply proves nothing here.
    const { reply } = splitQuotedReply(
      "Confirmed.\r\nShipping Friday.\r\n\r\nOn Mon, Oct 13, 2026 at 9:02 AM PPP wrote:\r\n> order"
    );
    expect(reply.trim()).toBe("Confirmed.\nShipping Friday.");
    expect(reply).not.toContain("\r");
  });
});

describe("the thread view uses it", () => {
  const src = () => strip(read("components/inbox-view.tsx"));

  it("folds the quote instead of dumping the whole body", () => {
    const s = src();
    expect(s).toContain("splitQuotedReply");
    expect(s).toMatch(/Show quoted text/);
    // The old unconditional dump is gone: body_text no longer renders
    // straight into a <pre> with no split.
    expect(s).not.toMatch(/<pre[^>]*>\s*\{message\.body_text\}/);
  });

  it("renders the whole body when there is nothing above the quote", () => {
    // Guards the one case where folding would HIDE the message.
    expect(src()).toMatch(/!reply\.trim\(\)[\s\S]{0,60}return\s*<pre/);
  });

  it("announces the fold to a screen reader", () => {
    expect(src()).toContain("aria-expanded={showQuoted}");
  });
});

describe("one rule, not two", () => {
  it("the bell preview shares the same cut", () => {
    // Two copies drift, and a preview that ends somewhere the thread does
    // not is its own bug.
    const s = strip(read("lib/notifications/supplier-reply.ts"));
    expect(s).toContain("splitQuotedReply");
    expect(s).not.toContain("Original Message");
  });
});
