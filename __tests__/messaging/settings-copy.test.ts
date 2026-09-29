import { describe, it, expect } from "vitest";
import {
  settingsDiff, patchFor, COPYABLE_SETTINGS, NEVER_COPIED,
  type WorkspaceSettings,
} from "@/lib/messaging/settings-copy";

/**
 * Copying one workspace's settings onto others.
 *
 * 32 workspaces, each with hours, weekend policy, reply delays and an
 * after-hours message set by hand. A policy change is 32 visits and 32
 * chances to type something slightly different, so drift is the default
 * outcome rather than an accident.
 *
 * The thing under test is mostly what CANNOT be copied. A timezone is
 * definitionally regional and the gate reads it to decide whether a send is
 * lawful, so copying Eastern onto a California workspace would move its whole
 * sending window and the gate would obey.
 */
const ws = (id: string, name: string, over: Partial<WorkspaceSettings> = {}): WorkspaceSettings => ({
  id, name,
  quiet_hours_start: 9, quiet_hours_end: 20, send_on_weekends: true,
  after_hours_autoreply: false, after_hours_message: null,
  reply_delay_min_seconds: 120, reply_delay_max_seconds: 300,
  ...over,
});

describe("what may never be copied", () => {
  it.each(["time_zone", "phone_e164", "reply_to_email", "name", "autosend_enabled"])(
    "keeps %s out of the copyable list", (field) => {
      expect(COPYABLE_SETTINGS).not.toContain(field);
      // And names the reason, because "why can I not copy the timezone?" is
      // the question somebody will ask.
      expect(NEVER_COPIED[field]).toBeTruthy();
    }
  );

  it("refuses to build a patch for one, even if asked directly", () => {
    // The allow-list is enforced where the values are produced, not in a
    // form — a caller that skips the form must not get further.
    const patch = patchFor(
      ws("a", "A", { quiet_hours_start: 10 }),
      ["quiet_hours_start", "time_zone" as never]
    );
    expect(patch).toEqual({ quiet_hours_start: 10 });
    expect(patch).not.toHaveProperty("time_zone");
  });

  it("ignores an uncopyable setting when diffing", () => {
    const diffs = settingsDiff({
      source: ws("a", "A"),
      targets: [ws("b", "B")],
      settings: ["time_zone" as never],
    });
    expect(diffs).toEqual([]);
  });
});

describe("what would actually change", () => {
  it("lists only the workspaces that differ", () => {
    /**
     * The count of workspaces is not the interesting number — the count of
     * CHANGES is. "Apply to 31" reads as a large action when 30 already
     * match and nothing happens to them.
     */
    const diffs = settingsDiff({
      source: ws("a", "A", { quiet_hours_end: 18 }),
      targets: [ws("b", "Same"), ws("c", "Different", { quiet_hours_end: 20 })],
      settings: ["quiet_hours_end"],
    });
    expect(diffs.map((d) => d.name)).toEqual(["Same", "Different"]);
    expect(diffs.every((d) => d.changes[0].to === "18")).toBe(true);
  });

  it("says nothing when everything already matches", () => {
    const diffs = settingsDiff({
      source: ws("a", "A"), targets: [ws("b", "B")], settings: [...COPYABLE_SETTINGS],
    });
    expect(diffs).toEqual([]);
  });

  it("never copies a workspace onto itself", () => {
    // It would be a no-op that still reported "1 workspace updated", which is
    // a lie somebody would act on.
    const source = ws("a", "A", { quiet_hours_end: 18 });
    const diffs = settingsDiff({ source, targets: [source], settings: ["quiet_hours_end"] });
    expect(diffs).toEqual([]);
  });

  it("reads a boolean as on or off, not true or false", () => {
    const diffs = settingsDiff({
      source: ws("a", "A", { send_on_weekends: false }),
      targets: [ws("b", "B", { send_on_weekends: true })],
      settings: ["send_on_weekends"],
    });
    expect(diffs[0].changes[0]).toMatchObject({ from: "on", to: "off" });
  });

  it("calls an empty after-hours message 'nothing' rather than blank", () => {
    const diffs = settingsDiff({
      source: ws("a", "A", { after_hours_message: "We're closed, back at {{next_open}}." }),
      targets: [ws("b", "B", { after_hours_message: null })],
      settings: ["after_hours_message"],
    });
    expect(diffs[0].changes[0].from).toBe("nothing");
  });

  it("does not report a change when two reads spell the same value differently", () => {
    // 9 from one query and "9" from another is not a change anybody made.
    const diffs = settingsDiff({
      source: ws("a", "A", { quiet_hours_start: 9 }),
      targets: [ws("b", "B", { quiet_hours_start: "9" })],
      settings: ["quiet_hours_start"],
    });
    expect(diffs).toEqual([]);
  });

  it("names the overwrite of a message somebody wrote", () => {
    // This is the change most likely to destroy work, so it has to appear in
    // the diff rather than hide inside a workspace count.
    const diffs = settingsDiff({
      source: ws("a", "A", { after_hours_message: "Standard wording." }),
      targets: [ws("b", "B", { after_hours_message: "Something Nassau wrote on purpose." })],
      settings: ["after_hours_message"],
    });
    expect(diffs[0].changes[0]).toMatchObject({
      from: "Something Nassau wrote on purpose.", to: "Standard wording.",
    });
  });
});
