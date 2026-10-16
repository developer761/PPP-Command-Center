/**
 * A CATCH CANNOT CATCH A RETURNED FAILURE.
 *
 * `sendEmail` resolves with `{ ok: false, error }` when Resend refuses it.
 * It does not throw. So this, which looks careful, is not:
 *
 *     try {
 *       await sendEmail({ … });
 *     } catch (err) {
 *       console.error("could not send:", err);
 *     }
 *
 * The catch never runs. The mail was not sent, the code carries on, and
 * nothing anywhere records it.
 *
 * Three sites were doing that on 2026-10-15, and one of them mattered more
 * than the other two put together. `emailFallback` in materials-alerts is
 * the path taken when SLACK IS ALREADY DOWN — and it returned
 * `{ ok: true, detail: "email" }` after an unchecked send. So
 * deliverMaterialsAlert was told the alert had been delivered, and its
 * "Nobody was told about this failure" branch — written deliberately for
 * that exact case — could never run. A bounced supplier order could fail
 * to report that it had failed, twice, and claim success doing it.
 *
 * The rule is simple enough to enforce: bind the result and look at it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      walk(rel, acc);
    } else if (e.name.endsWith(".ts")) acc.push(rel);
  }
  return acc;
}

/**
 * `await sendEmail(` as a bare statement — nothing on the left of it, so
 * the { ok:false } it may resolve with goes nowhere.
 */
const UNBOUND_SEND = /^[ \t]*await\s+sendEmail\s*\(/m;

describe("a returned failure is looked at", () => {
  const files = [...walk("app"), ...walk("lib")].filter(
    (f) => !/\/commercial\/|\/messaging\//.test(f)
  );

  it("scanned a real number of files", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("every sendEmail result is bound to something", () => {
    const offenders = files.filter((f) => UNBOUND_SEND.test(read(f)));
    expect(
      offenders,
      "sendEmail RESOLVES with { ok: false } — it does not throw, so a " +
        "try/catch around it is not a check. Bind the result and test res.ok:\n" +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("and the bound result is actually tested", () => {
    const unchecked: string[] = [];
    for (const f of files) {
      const src = read(f);
      if (!/await sendEmail\s*\(/.test(src)) continue;
      // Every file that sends must look at an ok somewhere.
      if (!/\.ok\b/.test(src)) unchecked.push(f);
    }
    expect(unchecked, `binds a sendEmail result and never reads .ok:\n${unchecked.join("\n")}`).toEqual([]);
  });

  it("the alert fallback can report its own failure again", () => {
    // The one that claimed success while Slack was already down.
    const src = read("lib/alerts/materials-alerts.ts");
    const at = src.indexOf("async function emailFallback");
    const fn = src.slice(at, src.indexOf("\n}", at));
    expect(fn).toMatch(/const res = await sendEmail\(/);
    expect(fn).toMatch(/if \(!res\?\.ok\)/);
    expect(fn).toMatch(/return \{ ok: false/);
  });

  it("deliverMaterialsAlert still has the branch that was unreachable", () => {
    // Proving the fix restores something, not just that a check exists.
    expect(read("lib/alerts/materials-alerts.ts")).toContain("Nobody was told about this failure");
  });
});
