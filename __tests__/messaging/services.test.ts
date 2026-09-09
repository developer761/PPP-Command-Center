import { describe, it, expect } from "vitest";
import {
  resolveServices, servicesPrompt, listPhrase, exceptionSummary,
  type Service,
} from "@/lib/messaging/services";

const s = (key: string, coveredByDefault = true, sortOrder = 10): Service => ({
  key, label: key, phrase: key.replace(/_/g, " "), coveredByDefault, sortOrder,
});

const LIST = [s("interior_painting", true, 10), s("flooring", true, 20), s("wallpaper", true, 30)];

describe("what a workspace covers", () => {
  /**
   * The rule that makes the global list mean "everywhere". The prose fields
   * this replaces resolved by REPLACEMENT: giving a workspace its own copy
   * froze it, so a service added to the default a month later never reached it.
   */
  it("follows the default when the workspace says nothing", () => {
    const r = resolveServices(LIST, []);
    expect(r.every((x) => x.covered)).toBe(true);
    expect(r.every((x) => !x.isException)).toBe(true);
  });

  it("turns one service off without touching the others", () => {
    const r = resolveServices(LIST, [{ serviceKey: "flooring", covered: false }]);
    expect(r.find((x) => x.key === "flooring")!.covered).toBe(false);
    expect(r.find((x) => x.key === "wallpaper")!.covered).toBe(true);
  });

  it("a new service reaches a workspace that never opted out of it", () => {
    // The whole point. Adding to the default list propagates.
    const withNew = [...LIST, s("power_washing", true, 40)];
    const r = resolveServices(withNew, [{ serviceKey: "flooring", covered: false }]);
    expect(r.find((x) => x.key === "power_washing")!.covered).toBe(true);
  });

  it("can turn a default-off service ON for one workspace", () => {
    const list = [s("interior_painting"), s("murals_ok", false, 99)];
    const r = resolveServices(list, [{ serviceKey: "murals_ok", covered: true }]);
    expect(r.find((x) => x.key === "murals_ok")!.covered).toBe(true);
    expect(r.find((x) => x.key === "murals_ok")!.isException).toBe(true);
  });

  it("does not call a row that agrees with the default an exception", () => {
    const r = resolveServices(LIST, [{ serviceKey: "flooring", covered: true }]);
    expect(r.find((x) => x.key === "flooring")!.isException).toBe(false);
  });

  it("ignores an exception for a service that no longer exists", () => {
    const r = resolveServices(LIST, [{ serviceKey: "gone", covered: false }]);
    expect(r).toHaveLength(3);
  });

  it("keeps the list in the order it is meant to be read", () => {
    const r = resolveServices([s("c", true, 30), s("a", true, 10), s("b", true, 20)], []);
    expect(r.map((x) => x.key)).toEqual(["a", "b", "c"]);
  });

  it("counts what differs, for a screen to show", () => {
    const sum = exceptionSummary(resolveServices(LIST, [{ serviceKey: "flooring", covered: false }]));
    expect(sum).toEqual({ covered: 2, notCovered: 1, differsFromDefault: 1 });
  });
});

describe("what the bot is told", () => {
  it("lists what this area does", () => {
    const p = servicesPrompt(resolveServices(LIST, []));
    expect(p).toContain("interior painting, flooring and wallpaper");
    expect(p).toMatch(/authoritative/);
  });

  /**
   * Leaving a service off a list is a weaker signal than saying we do not do
   * it here — especially while the global prose still mentions it. The model
   * will otherwise agree to flooring in a workspace that does not do flooring.
   */
  it("says explicitly what this area does NOT do", () => {
    const p = servicesPrompt(resolveServices(LIST, [{ serviceKey: "flooring", covered: false }]));
    expect(p).toMatch(/WE DO NOT OFFER THESE IN THIS AREA/);
    expect(p).toMatch(/flooring/);
    expect(p).toMatch(/do not agree to them/);
  });

  it("says nothing about exclusions when there are none", () => {
    const p = servicesPrompt(resolveServices(LIST, []));
    expect(p).not.toMatch(/WE DO NOT OFFER/);
  });

  it("handles a workspace that covers nothing without producing nonsense", () => {
    const p = servicesPrompt(resolveServices(LIST, LIST.map((x) => ({ serviceKey: x.key, covered: false }))));
    expect(p).not.toMatch(/WHAT WE DO IN THIS AREA/);
    expect(p).toMatch(/WE DO NOT OFFER/);
  });

  it("reads like a person, not a database", () => {
    expect(listPhrase(["a"])).toBe("a");
    expect(listPhrase(["a", "b"])).toBe("a and b");
    expect(listPhrase(["a", "b", "c"])).toBe("a, b and c");
    expect(listPhrase([])).toBe("");
  });

  it("is in English", () => {
    const p = servicesPrompt(resolveServices(LIST, [{ serviceKey: "flooring", covered: false }]));
    // A stray Cyrillic word got into this template once.
    expect(p).not.toMatch(/[Ѐ-ӿ]/);
  });
});
