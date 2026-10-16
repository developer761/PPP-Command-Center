/**
 * Kate 2026-10-14: "how do the guys view vendor replies to the materials
 * order? Are they in the hub only or are they emailed to the guys?"
 *
 * Answering it turned up the gap. Replies threaded correctly against the
 * right order and PO, and NOTHING announced them — the only signal was an
 * unread count you see once you are already in Mail. A vendor writing "we're
 * out of Revere Pewter" sat there until somebody wandered past.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replyPreview } from "@/lib/notifications/supplier-reply";
import { stripComments } from "../helpers/strip-comments";

const read = (p: string) => stripComments(readFileSync(join(process.cwd(), p), "utf8"));
const strip = (s: string) =>
  stripComments(s);

describe("the preview line", () => {
  it("drops the quoted thread", () => {
    const body = [
      "We're out of Revere Pewter until Thursday.",
      "",
      "> 2 gal — Ultra Spec INT — HC-172 Revere Pewter",
      "> 1 bucket — Super White",
    ].join("\n");
    expect(replyPreview(body)).toBe("We're out of Revere Pewter until Thursday.");
  });

  it("drops the 'On ... wrote:' header", () => {
    const body = "Confirmed for Friday.\n\nOn Mon, Oct 13, 2026 at 9:02 AM PPP wrote:\n> order";
    expect(replyPreview(body)).toBe("Confirmed for Friday.");
  });

  it("drops a REAL attribution, which is longer than the first rule allowed", () => {
    // Verbatim from Kate's 2026-10-14 reply, which previewed as her sentence
    // followed by the header of the mail she was answering. The old rule
    // capped the middle at 80 chars; a real one with an address is longer.
    const body =
      'Hitting "reply" not "reply all" as a test. I am the vendor\n\n' +
      "On Wed, Oct 14, 2026 at 11:22 AM PPP Support <support@precisionpaintingplus.net> wrote:\n" +
      "> 2 gal — Ultra Spec INT — HC-172 Revere Pewter";
    expect(replyPreview(body)).toBe('Hitting "reply" not "reply all" as a test. I am the vendor');
  });

  it("drops an attribution Gmail has WRAPPED across lines", () => {
    // "wrote:" is routinely not on the same line as the "On", which the
    // line-by-line rule could never have matched.
    const body =
      "Confirmed, shipping Friday.\n\n" +
      "On Wed, Oct 14, 2026 at 11:22 AM Precision Painting Plus\n" +
      "<support@precisionpaintingplus.net>\nwrote:\n> the order";
    expect(replyPreview(body)).toBe("Confirmed, shipping Friday.");
  });

  it("drops Outlook's separator too", () => {
    expect(replyPreview("We have it in stock.\n\n-----Original Message-----\nFrom: PPP"))
      .toBe("We have it in stock.");
  });

  it("keeps a reply that merely contains the word 'on'", () => {
    // The cut must not fire on ordinary prose.
    expect(replyPreview("On Friday we can deliver the Revere Pewter."))
      .toBe("On Friday we can deliver the Revere Pewter.");
  });

  it("truncates rather than pasting a whole email into a bell row", () => {
    expect(replyPreview("x".repeat(400)).length).toBeLessThanOrEqual(180);
    expect(replyPreview("x".repeat(400))).toMatch(/…$/);
  });

  it("is empty, not crashy, for nothing", () => {
    expect(replyPreview(null)).toBe("");
    expect(replyPreview("")).toBe("");
    expect(replyPreview("> only quoted text")).toBe("");
  });
});

describe("who gets told", () => {
  const src = () => strip(read("lib/notifications/supplier-reply.ts"));

  it("the person who sent the order", () => {
    const s = src();
    expect(s).toMatch(/created_by_user_id/);
    expect(s).toMatch(/\.eq\("user_id", senderId\)/);
  });

  it("skips a deactivated sender rather than mailing them", () => {
    expect(src()).toMatch(/p\.is_active !== false/);
  });

  it("falls back to admins ONLY when there is no usable sender", () => {
    // Copying every admin on every vendor reply is how a notification
    // becomes wallpaper. The fallback exists so nobody is told nothing.
    const s = src();
    const guardAt = s.indexOf("if (recipients.length === 0)");
    const fallbackAt = s.indexOf('.eq("is_admin", true)');
    expect(guardAt).toBeGreaterThan(-1);
    expect(fallbackAt).toBeGreaterThan(guardAt);
  });

  it("links straight to the thread for that job", () => {
    expect(src()).toMatch(/\/dashboard\/inbox\?workOrderId=/);
  });

  it("checks the RESULT of the send, which returns {ok:false}", () => {
    expect(src()).toMatch(/if \(!res\?\.ok\)/);
  });
});

describe("the webhook stays safe", () => {
  const hook = () => strip(read("app/api/webhooks/resend-inbound/route.ts"));

  it("notifies only for a reply actually placed against an order", () => {
    expect(hook()).toMatch(/if \(!insertErr && kind === "supplier_reply" && linkedOrderId\)/);
  });

  it("does not await it into the response", () => {
    // A slow or failed notification must not make Resend retry — a retry
    // re-delivers the same reply.
    expect(hook()).not.toMatch(/await notifySupplierReply\(/);
  });

  it("but is not merely detached either", () => {
    // `void` satisfied the rule above and lost the work: on Vercel the
    // instance freezes at the response, so the bell and email telling
    // somebody a vendor replied could simply never happen. afterResponse
    // keeps both properties — the 200 goes back first, the work survives.
    expect(hook()).toMatch(/afterResponse\("vendor reply notification", \(\) =>/);
  });

  it("fires only after the message is stored", () => {
    const h = hook();
    expect(h.indexOf(".insert({")).toBeLessThan(h.indexOf('afterResponse("vendor reply notification"'));
  });
});

describe("the bell can render it", () => {
  it("has a label, or the row shows blank", () => {
    expect(read("lib/notifications/labels.ts")).toMatch(/supplier_reply: \{ label: "Vendor replied"/);
  });
});

/**
 * Kate, 2026-10-14, after a clean end-to-end test: "both messages state no
 * text in the reply but I included text in both replies."
 *
 * She had. Resend's webhook carries metadata only, and the follow-up fetch
 * for the body came back HTTP 401 — the API key can send but cannot read
 * received mail. Nothing was stored, and both the bell and the Mail Hub
 * asserted the reply was empty.
 *
 * The key is a dashboard fix. Claiming the vendor wrote nothing is ours: a
 * reader told the reply is empty does not go and look, which is the whole
 * point of the notification.
 */
describe("an unreadable body is not an empty one", () => {
  const read2 = (p: string) => stripComments(readFileSync(join(process.cwd(), p), "utf8"));
  const strip2 = (s: string) =>
    stripComments(s);

  it("the notification says it could not be loaded", () => {
    const s = strip2(read2("lib/notifications/supplier-reply.ts"));
    expect(s).toMatch(/const bodyMissing = !input\.bodyText/);
    expect(s).toMatch(/couldn't be loaded/);
  });

  it("still says '(no text in the reply)' when there genuinely is none", () => {
    // The honest version of the message has to survive, or we have swapped
    // one false claim for another.
    expect(strip2(read2("lib/notifications/supplier-reply.ts"))).toMatch(/\(no text in the reply\)/);
  });

  it("the Mail Hub tells the two states apart", () => {
    const s = strip2(read2("components/inbox-view.tsx"));
    expect(s).toMatch(/message\.has_html/);
    expect(s).toMatch(/no plain-text body — HTML only/);
    expect(s).toMatch(/couldn't be loaded/);
  });

  it("the API sends the fact, not the markup", () => {
    // A reply's HTML runs to tens of kilobytes and the screen needs one
    // boolean from it.
    const s = strip2(read2("app/api/admin/inbox/route.ts"));
    expect(s).toMatch(/has_html: Boolean\(body_html\)/);
    expect(s).toMatch(/const \{ body_html, raw_payload, \.\.\.rest \}/);
  });
});
