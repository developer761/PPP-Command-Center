/**
 * THE HEALTH PAGE HAS TO NAME THE SETTING THAT MAKES LAUNCH A NO-OP.
 *
 * Writeback defaults to `test_only`: Salesforce is written only for work
 * orders on an allowlist, and every other customer submission is saved in
 * the hub and goes no further. Correct while building, catastrophic on
 * launch day — the form works, the emails send, the AM is notified, and the
 * colors never reach Salesforce. Nothing errors and nobody is told.
 *
 * Settings → Health is where someone looks before going live. It was
 * checking Resend, Slack, suppliers and four migrations, and not this.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
const health = () => strip(readFileSync(join(root, "app/api/admin/health/route.ts"), "utf8"));

describe("the health page reports the writeback mode", () => {
  it("has a check for it at all", () => {
    const s = health();
    expect(s).toContain('id: "writeback_mode"');
    expect(s).toContain("getWritebackMode");
  });

  it("reads the real mode rather than an env var", () => {
    // The mode lives in the database and is changed from the settings page,
    // so an env-var check would report something nobody edits.
    expect(health()).toMatch(/const mode = await getWritebackMode\(\)/);
  });

  it("FAILS the check on anything but 'all'", () => {
    // A warning is not enough. test_only on launch day loses customer data
    // silently, which is the loudest kind of problem to have.
    const s = health();
    const at = s.indexOf('id: "writeback_mode"');
    const block = s.slice(at, at + 400);
    expect(block).toMatch(/status:\s*mode === "all" \? "ok" : "fail"/);
  });

  it("says how many work orders test_only would actually cover", () => {
    // "test_only" alone does not tell you the blast radius; the allowlist
    // length does.
    //
    // The first version of this asserted the file CONTAINS "loadAllowlist"
    // and survived deleting the call, because the import line still matched.
    // Scope it to the check, and to the call rather than the name.
    const s = health();
    const at = s.indexOf('id: "writeback_mode"');
    const block = s.slice(Math.max(0, at - 400), at + 900);
    expect(block).toMatch(/await loadAllowlist\(\)/);
    expect(block).toMatch(/allowlist\.length/);
  });

  it("tells the reader where to change it", () => {
    const s = health();
    const at = s.indexOf('id: "writeback_mode"');
    expect(s.slice(at, at + 1400)).toMatch(/Settings → Salesforce Writeback/);
  });
});
