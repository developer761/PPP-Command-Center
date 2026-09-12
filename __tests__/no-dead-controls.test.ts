import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * A control that is permanently off.
 *
 * Karan, 2026-09-12: "half the systems dont even wokr". The cause was a button
 * written as `disabled` with no expression behind it — the training import,
 * switched off during the build pending a question that had already been
 * answered, and never switched back on. Kate could preview an import as often
 * as she liked and never perform one.
 *
 * A disabled attribute bound to state is fine: something can turn it on. A bare
 * `disabled` cannot be turned on by anyone, so the screen is a picture of a
 * feature. That is the failure this test exists to catch, because it is
 * invisible to the type checker and to the build — the page renders perfectly.
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

const BARE = /^\s*disabled\s*$/;
const INLINE = /<(button|input|textarea|select)\b[^>]*\sdisabled(\s|>|\/)/;

describe("no permanently dead controls", () => {
  it("has files to check", () => {
    expect(FILES.length).toBeGreaterThan(10);
  });

  it("no button or input is hardcoded disabled", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (BARE.test(line) || INLINE.test(line)) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(offenders, `hardcoded disabled — nobody can turn these on:\n${offenders.join("\n")}`)
      .toEqual([]);
  });

  it("the check can fail", () => {
    // Control. Without this the assertion above passes when the regex is wrong.
    expect(BARE.test("      disabled")).toBe(true);
    expect(INLINE.test('<button type="button" disabled >')).toBe(true);
    // And does not fire on the legitimate bound form.
    expect(BARE.test("      disabled={busy}")).toBe(false);
    expect(INLINE.test("<button disabled={busy || !body}>")).toBe(false);
  });
});
