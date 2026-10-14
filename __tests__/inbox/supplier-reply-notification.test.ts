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

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

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
    expect(hook()).toMatch(/void notifySupplierReply\(/);
  });

  it("fires only after the message is stored", () => {
    const h = hook();
    expect(h.indexOf(".insert({")).toBeLessThan(h.indexOf("void notifySupplierReply("));
  });
});

describe("the bell can render it", () => {
  it("has a label, or the row shows blank", () => {
    expect(read("lib/notifications/labels.ts")).toMatch(/supplier_reply: \{ label: "Vendor replied"/);
  });
});
