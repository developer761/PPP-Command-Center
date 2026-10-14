/**
 * Repairing replies that arrived without their text.
 *
 * Through 2026-10-14 the fetch that pulls an inbound body back from Resend
 * returned 401 on every message — the API key could send but not read. The
 * replies threaded fine and arrived empty, and the hub reported that the
 * vendor had written nothing.
 *
 * The text never left Resend. This pulls it back for anything already
 * stored, and answers "is the key fixed?" without sending another test
 * email and waiting for it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
const route = () => strip(read("app/api/admin/inbox/backfill-bodies/route.ts"));

describe("the backfill", () => {
  it("is admin only", () => {
    // It reads message bodies across every work order — wider than the
    // scope-gated Mail Hub gives a rep.
    const r = route();
    expect(r).toMatch(/roleForProfile\(profile, isAdminEmail\(auth\.user\.email\)\) !== "admin"/);
    expect(r).toMatch(/status: 403/);
  });

  it("GET changes nothing", () => {
    const r = route();
    expect(r).toMatch(/export async function GET\(\) \{\s*return run\(false\)/);
    expect(r).toMatch(/export async function POST\(\) \{\s*return run\(true\)/);
  });

  it("only touches messages that have no text", () => {
    expect(route()).toMatch(/\.is\("body_text", null\)/);
  });

  it("uses the SAME fetch the webhook uses", () => {
    // Two implementations would drift, and the repair would quietly store
    // something different from the live path.
    expect(route()).toMatch(/from "@\/lib\/email\/resend-receiving"/);
    expect(strip(read("app/api/webhooks/resend-inbound/route.ts")))
      .toMatch(/from "@\/lib\/email\/resend-receiving"/);
  });

  it("says WHY a fetch failed, not just that it did", () => {
    const r = route();
    expect(r).toMatch(/Full access, not Sending access/);
  });

  it("reports whether the key can read at all", () => {
    // The question being asked is "is the key fixed", so answer it directly
    // rather than making somebody infer it from a list.
    expect(route()).toMatch(/keyCanReadReceivedEmail/);
  });

  it("does not claim success when there was nothing to repair", () => {
    // Zero bodyless messages means the question is unanswered, not "yes".
    expect(route()).toMatch(/\(rows\?\.length \?\? 0\) === 0 \? null : unreadable === 0/);
  });

  it("distinguishes 'Resend has no body' from 'we could not read it'", () => {
    const r = route();
    expect(r).toMatch(/resend_has_no_body/);
    expect(r).toMatch(/fetch_failed/);
  });
});

/**
 * Karan, shown the repair endpoint: "why do i have to do this".
 *
 * He shouldn't. A message missing its text knows how to go and get it, and
 * the moment somebody opens Mail is exactly when it is wanted. So the Mail
 * Hub heals itself and the bulk endpoint goes back to being a diagnostic.
 */
describe("the Mail Hub repairs a missing body by itself", () => {
  const read2 = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const strip2 = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const api = () => strip2(read2("app/api/admin/inbox/route.ts"));

  it("fetches the body when a message has none", () => {
    const s = api();
    expect(s).toMatch(/from "@\/lib\/email\/resend-receiving"/);
    expect(s).toMatch(/!m\.body_text && !m\.body_html/);
  });

  it("writes it back, so the next reader costs nothing", () => {
    expect(api()).toMatch(/\.update\(\{ body_text: fetched\.text, body_html: fetched\.html \}\)/);
  });

  it("does nothing at all when every message has a body", () => {
    // The normal case must not pay for the broken one.
    expect(api()).toMatch(/if \(needBody\.length > 0\)/);
  });

  it("caps the attempts per request", () => {
    // A genuinely broken key would otherwise turn every page load into a
    // row of doomed round trips.
    const s = api();
    expect(s).toMatch(/MAX_HEAL_PER_REQUEST = 5/);
    expect(s).toMatch(/\.slice\(0, MAX_HEAL_PER_REQUEST\)/);
  });

  it("never ships raw_payload or body_html to the browser", () => {
    // raw_payload is only selected to read the email_id out of it, and it
    // holds the entire original webhook body.
    const s = api();
    expect(s).toMatch(/const \{ body_html, raw_payload, \.\.\.rest \}/);
  });
});
