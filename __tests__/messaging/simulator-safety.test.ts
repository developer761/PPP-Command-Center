import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The simulator must have no way to reach a person.
 *
 * Not "sending is disabled" — no send path at all. Kate will be testing this
 * against a live database with real workspace numbers loaded, and the only
 * thing standing between a sandbox and a text message is that the code to send
 * one is not present. That is worth asserting rather than trusting.
 */
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
      expect(readFileSync(f, "utf8"), f).not.toMatch(/from\s+["'].*messaging\/transport["']/);
    }
  });

  it("never calls the gate", () => {
    // Even the gate is too close. The gate exists to decide whether a real
    // send is allowed; the simulator has nothing to decide about.
    for (const f of SIM_FILES) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/\bgatedSend\b/);
    }
  });

  it("never touches a scheduled action or a conversation", () => {
    // A queued action is a future send. A conversation row is a real customer
    // thread. The sandbox creates neither.
    for (const f of SIM_FILES) {
      const src = readFileSync(f, "utf8");
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
});
