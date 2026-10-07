import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The gate is only a chokepoint while it is the ONLY path to the transport.
 *
 * Every agent, the campaign scheduler and the office composer all want to send.
 * The rules — suppression, quiet hours, the daily cap — live in gatedSend(),
 * and the moment one caller reaches the carrier directly those rules become
 * advisory. That will not announce itself: the code compiles, the tests pass,
 * and the failure surfaces as a message to somebody who opted out.
 *
 * So it is enforced structurally rather than by reviewer memory.
 *
 * Allowed to touch the transport:
 *   lib/messaging/gate.ts        the chokepoint itself
 *   lib/messaging/transport.ts   the definition
 *   lib/messaging/transports/*   concrete adapters (Twilio, AWS), which
 *                                implement the interface and are constructed
 *                                by the gate, never called around it
 * Everything else is a bug.
 */
const ALLOWED = new Set([
  "lib/messaging/gate.ts",
  "lib/messaging/transport.ts",
]);
const ALLOWED_DIR = "lib/messaging/transports/";
const ROOTS = ["app", "lib", "components"];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(e)) out.push(full);
  }
  return out;
}

/** Does this source import the messaging transport module? */
const IMPORTS_TRANSPORT = /from\s+["'](?:@\/lib\/messaging\/transport|\.\/transport|\.\.\/transport)["']/;

describe("the gate is the only path to the carrier", () => {
  const files = ROOTS.flatMap((r) => walk(r));

  it("scanned a meaningful number of files", () => {
    // A zero-file scan reports a perfect pass forever.
    expect(files.length).toBeGreaterThan(200);
  });

  it("no file outside the gate imports the transport", () => {
    const offenders = files.filter((f) => {
      if (ALLOWED.has(f) || f.startsWith(ALLOWED_DIR)) return false;
      return IMPORTS_TRANSPORT.test(readFileSync(f, "utf8"));
    });
    expect(offenders).toEqual([]);
  });

  it("gate.ts is the only place that calls .send() on a transport", () => {
    const offenders = files.filter((f) => {
      if (ALLOWED.has(f) || f.startsWith(ALLOWED_DIR)) return false;
      const src = readFileSync(f, "utf8");
      return /\btransport\s*\.\s*send\s*\(/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it("gatedSend is the module's only exported way to send", () => {
    const src = readFileSync("lib/messaging/gate.ts", "utf8");
    const exportedFns = [...src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]);
    // Helpers may be exported for testing, but only one of them sends.
    expect(exportedFns).toContain("gatedSend");
    const senders = exportedFns.filter((n) => /send/i.test(n));
    expect(senders).toEqual(["gatedSend"]);
  });

  /**
   * AND THE SCRIPTS, WHICH THIS DID NOT LOOK AT.
   *
   * ROOTS is app/lib/components and the walk takes .ts/.tsx, so scripts/*.mjs
   * were invisible — and two of them called gatedSend with no transport
   * injected. The gate resolves its own when the caller supplies none
   * (`deps.transport ?? activeTransport()`), so `npm run verify` would have
   * POSTed to the carrier the day live sending is switched on, from a script
   * whose header says "it sends nothing".
   *
   * Scripts are allowed to call gatedSend — that is the point of an end-to-end
   * check — but they must bring their own transport.
   */
  it("every script that calls gatedSend injects its own transport", () => {
    const scripts = readdirSync("scripts").filter((f) => /\.mjs$/.test(f));
    expect(scripts.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const f of scripts) {
      const src = readFileSync(join("scripts", f), "utf8");
      if (!/\bgatedSend\s*\(/.test(src)) continue;
      // Every call has to pass deps carrying a transport. Checked as "the file
      // never passes a bare gateDeps(sb)", which is the shape that resolves the
      // live carrier.
      if (/gatedSend\([\s\S]{0,400}?\n\s*gateDeps\(sb\),?\s*\)/.test(src)
          || /,\s*gateDeps\(sb\)\s*\)/.test(src)) {
        offenders.push(`scripts/${f}`);
      }
    }
    expect(offenders, "a script would resolve the live carrier").toEqual([]);
  });

  it("detects a violation — proving the check can fail", () => {
    // The exact shape that would break the chokepoint.
    const bad = `import { LoggingTransport } from "@/lib/messaging/transport";\nawait transport.send(a, b, c);`;
    expect(IMPORTS_TRANSPORT.test(bad)).toBe(true);
    expect(/\btransport\s*\.\s*send\s*\(/.test(bad)).toBe(true);
    const good = `import { gatedSend } from "@/lib/messaging/gate";`;
    expect(IMPORTS_TRANSPORT.test(good)).toBe(false);
  });
});
