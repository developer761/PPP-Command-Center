/**
 * THE WEBHOOK ANSWERED 200 AND THREW EVERY REPLY AWAY.
 *
 * Kate, 2026-10-14: "I sent two emails … I don't see the vendor's replies in
 * the hub." Production logs showed Resend delivering both, our endpoint
 * answering HTTP 200, and nothing stored.
 *
 * Resend sends `from` as a STRING — "Acme <onboarding@resend.dev>" — and
 * `to` as an array of strings. The handler read `data.from?.email`, got
 * undefined on every real delivery, and took its `no_from` early return.
 * Because that return is a 200, Resend never retried and nothing ever
 * alerted. The single row in the table is from 2026-09-03, the last time the
 * payload matched what the code expected.
 *
 * These test the parser against BOTH shapes. The September row proves the
 * nested form existed, so neither is hypothetical.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAddress } from "@/app/api/webhooks/resend-inbound/route";
import { stripComments } from "../helpers/strip-comments";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const strip = (s: string) =>
  stripComments(s);
const route = () => strip(read("app/api/webhooks/resend-inbound/route.ts"));

describe("the address shape Resend actually sends", () => {
  it("reads a display-name string — the shape that was dropping everything", () => {
    expect(parseAddress("Acme <onboarding@resend.dev>")).toEqual({
      email: "onboarding@resend.dev",
      name: "Acme",
    });
  });

  it("reads a bare address with no display name", () => {
    expect(parseAddress("k.sutton@precisionpaintingplus.net")).toEqual({
      email: "k.sutton@precisionpaintingplus.net",
      name: null,
    });
  });

  it("strips quotes around a display name", () => {
    expect(parseAddress('"Sutton, Kate" <k@ppp.net>')).toEqual({
      email: "k@ppp.net",
      name: "Sutton, Kate",
    });
  });

  it("still reads the nested object form", () => {
    // The 2026-09-03 row arrived this way. Accepting only the new shape
    // would be swapping one guess for another.
    expect(parseAddress({ email: "a@b.com", name: "A B" })).toEqual({
      email: "a@b.com",
      name: "A B",
    });
  });

  it("returns null rather than nonsense for junk", () => {
    expect(parseAddress(null).email).toBeNull();
    expect(parseAddress(undefined).email).toBeNull();
    expect(parseAddress("not an address").email).toBeNull();
    expect(parseAddress({}).email).toBeNull();
    expect(parseAddress(42 as unknown).email).toBeNull();
  });
});

describe("the handler uses it", () => {
  it("parses From through the parser, not a property read", () => {
    const r = route();
    expect(r).toMatch(/const parsedFrom = parseAddress\(data\.from\)/);
    expect(r, "the exact read that dropped every delivery").not.toMatch(/data\.from\?\.email/);
  });

  it("parses To the same way", () => {
    expect(route()).toMatch(/parseAddress\(data\.to\[0\]\)\.email/);
  });

  it("REPORTS a dropped message instead of returning 200 in silence", () => {
    // The guard can still fire on a genuinely malformed From. What it must
    // never do again is swallow a well-formed delivery without a trace.
    const r = route();
    const at = r.indexOf('ignored: "no_from"');
    expect(at).toBeGreaterThan(-1);
    expect(r.slice(Math.max(0, at - 500), at)).toMatch(/resend_inbound_no_from/);
  });
});

describe("the body the webhook does not send", () => {
  it("is fetched by id from the receiving API", () => {
    // Resend: "webhooks do not include the email body, headers, or
    // attachments, only their metadata."
    //
    // The call itself lives in lib/email/resend-receiving.ts — the backfill
    // that repairs messages stored while this was failing has to make the
    // identical call, and two copies would drift.
    expect(route()).toMatch(/fetchReceivedEmail\(data\.email_id\)/);
    expect(strip(read("lib/email/resend-receiving.ts")))
      .toMatch(/https:\/\/api\.resend\.com\/emails\/receiving\//);
  });

  it("only fetches when the payload really lacks it", () => {
    expect(route()).toMatch(/data\.text \|\| data\.html \? null : await fetchReceivedEmail/);
  });

  it("stores the reply anyway when the fetch fails", () => {
    // A reply filed against the right order with an empty body beats no
    // reply at all — the subject matcher still threads it.
    expect(route()).toMatch(/data\.text \?\? fetched\?\.text \?\? null/);
    expect(strip(read("lib/email/resend-receiving.ts"))).toMatch(/resend_inbound_fetch_failed/);
  });

  it("matches In-Reply-To case-insensitively", () => {
    expect(route()).toMatch(/k\.toLowerCase\(\) === name/);
  });
});
