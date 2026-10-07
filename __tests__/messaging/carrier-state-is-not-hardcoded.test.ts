import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * A screen must not announce what the carrier is doing from a constant.
 *
 * `transportChoice()` decides at runtime whether a message reaches a phone —
 * it reads SMS_LIVE_SENDING and the carrier credentials, and it is one
 * environment change away from flipping. The dashboard and the review queue
 * both read it and render `transport.why`.
 *
 * The thread screen did not. It carried the sentence "Sending is off until the
 * carrier is connected" as literal text, in a fixed bar directly beneath
 * ThreadComposer — whose Send button calls gatedSend and really does reach a
 * phone. True the day it was written, and wrong from the morning PPP goes
 * live, on the screen somebody has open all day. Nothing would have reported
 * it: the page renders perfectly either way.
 *
 * So any file that talks about sending being off has to be reading the answer
 * from somewhere. This asserts the SHAPE — a source for the claim — rather
 * than the one sentence that was wrong, because the next version of this bug
 * will be phrased differently.
 */

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const FILES = [...walk("components/messaging"), ...walk("app/messaging")];

/** Comments describe the bug. They must not be read as the bug. */
const code = (f: string) =>
  fs.readFileSync(f, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** Phrases that assert the carrier's state to the reader. */
const CLAIMS = [
  /sending is off/i,
  /not (?:yet )?connected to (?:the )?carrier/i,
  /carrier is(?: not)? connected/i,
  /nothing is being delivered/i,
  /messages are being delivered/i,
];

/** Something that could have supplied the answer. */
const HAS_A_SOURCE = /transportChoice|transport\.|sendingIsLive|\blive\b\s*[?&]|props\.sending|sending\s*[?:]/;

describe("no screen hardcodes what the carrier is doing", () => {
  it("has files to check", () => {
    expect(FILES.length).toBeGreaterThan(10);
  });

  it("every claim about sending is read from somewhere", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = code(f);
      if (!CLAIMS.some((re) => re.test(src))) continue;
      if (!HAS_A_SOURCE.test(src)) offenders.push(f);
    }
    expect(offenders, "a screen states the carrier's state as a constant").toEqual([]);
  });

  it("the thread screen in particular reads it", () => {
    // The one that was wrong, pinned by name as well as by shape: it is the
    // most-visited screen and the only one sitting under a live composer.
    const teach = code("components/messaging/thread-teach.tsx");
    expect(teach).toMatch(/sendingIsLive/);
    const page = code("app/messaging/[conversationId]/page.tsx");
    expect(page).toMatch(/transportChoice\(\)/);
    expect(page).toMatch(/sendingIsLive=\{/);
  });
});
