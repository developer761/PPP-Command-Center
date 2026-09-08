import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

/**
 * The simulator must have no way to reach a person.
 *
 * Not "sending is disabled" — no send path at all. Kate will be testing this
 * against a live database with real workspace numbers loaded, and the only
 * thing standing between a sandbox and a text message is that the code to send
 * one is not present. That is worth asserting rather than trusting.
 */
/**
 * Source with comments removed.
 *
 * The checks below are about what the code DOES, and a comment naming
 * gatedSend to explain why the sandbox must never call it is the opposite of a
 * violation — it is the reason written down. Matching raw text failed on
 * exactly that, which is a false positive that teaches people to water down
 * the comment rather than fix the code.
 */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const SIM_FILES = [
  "lib/messaging/simulator.ts",
  "components/messaging/simulator.tsx",
  "app/messaging/training/simulator/page.tsx",
];

describe("the simulator cannot text anybody", () => {
  it("scans the files it claims to scan", () => {
    for (const f of SIM_FILES) expect(readFileSync(f, "utf8").length).toBeGreaterThan(100);
  });

  it("never imports the transport", () => {
    for (const f of SIM_FILES) {
      expect(code(f), f).not.toMatch(/from\s+["'].*messaging\/transport["']/);
    }
  });

  it("never calls the gate", () => {
    // Even the gate is too close. The gate exists to decide whether a real
    // send is allowed; the simulator has nothing to decide about.
    for (const f of SIM_FILES) {
      expect(code(f), f).not.toMatch(/\bgatedSend\b/);
    }
  });

  it("never touches a scheduled action or a conversation", () => {
    // A queued action is a future send. A conversation row is a real customer
    // thread. The sandbox creates neither.
    for (const f of SIM_FILES) {
      const src = code(f);
      expect(src, f).not.toMatch(/sms_scheduled_actions/);
      expect(src, f).not.toMatch(/from\(["']sms_conversations["']\)/);
    }
  });

  it("writes only to the scenario tables", () => {
    const src = readFileSync("lib/messaging/simulator.ts", "utf8");
    const writes = [...src.matchAll(/\.from\(["']([a-z_]+)["']\)[\s\S]{0,80}?\.insert/g)].map((m) => m[1]);
    expect(new Set(writes)).toEqual(new Set(["sms_scenarios", "sms_scenario_turns"]));
  });

  it("detects a violation — proving the check can fail", () => {
    const bad = `import { LoggingTransport } from "@/lib/messaging/transport";\nawait gatedSend(x, y);`;
    expect(bad).toMatch(/from\s+["'].*messaging\/transport["']/);
    expect(bad).toMatch(/\bgatedSend\b/);
  });

  /** Stripping comments must not become a way to smuggle a real call past the
   *  check — a violation on the same line as a comment still has to be seen. */
  it("still catches a real call that sits beside a comment", () => {
    const f = `${process.env.TMPDIR ?? "/tmp"}/sim-safety-control.ts`;
    writeFileSync(f, `// we must never call gatedSend\nawait gatedSend(a, b); // do it anyway\n`);
    expect(code(f)).toMatch(/\bgatedSend\b/);
    unlinkSync(f);
  });
});
