import { describe, it, expect } from "vitest";
import { checkSnippet, usableSnippets, resolveSnippets } from "@/lib/messaging/snippets";

/**
 * Reusable replies a person drops into a thread. Hatch parity.
 *
 * The distinction this file is built around: a snippet is HUMAN-facing. It is
 * inserted into a composer, read by the person sending it, and editable
 * before it goes. workspace-faq.ts checks its content hard because a model
 * repeats an FAQ with nobody in between; here the reader is the check.
 *
 * So the only content worth refusing is what a reader CANNOT catch by
 * reading, and there is one of those.
 */
describe("what a snippet is not allowed to be", () => {
  const why = (name: string, body: string) =>
    checkSnippet({ name, body }).map((p) => p.why).join(" ");

  it("refuses a merge field nothing fills", () => {
    /**
     * The one a reader cannot catch. "{{estimator_name}}" looks deliberate in
     * a composer — like the system will handle it — and the gate then refuses
     * the send AFTER they have hit send, on a screen that has moved on.
     * fillMergeFields deliberately leaves an unfillable field in place rather
     * than blanking it, so the rep would be inserting the literal token.
     */
    expect(why("Availability", "Hi, {{estimator_name}} will be in touch."))
      .toMatch(/nothing fills in \{\{estimator_name\}\}/);
  });

  it("allows the merge fields that ARE filled", () => {
    expect(checkSnippet({
      name: "Availability",
      body: "Hi {{customer_name}}, it's {{workspace_name}}. Call us on {{workspace_phone}}.",
    })).toEqual([]);
  });

  it("refuses a nameless snippet, because nobody could find it", () => {
    expect(why("", "Some text.")).toMatch(/no name/);
  });

  it("refuses an empty one", () => {
    expect(why("Availability", "   ")).toMatch(/empty/);
  });

  it("refuses something long enough to be its own message", () => {
    expect(why("Long", "x".repeat(950))).toMatch(/starting point somebody edits/);
  });

  /**
   * DELIBERATELY ALLOWED, and the reason this is not a copy of checkFaq.
   *
   * A1 and A18 bind the BOT. A person answering a thread may well need to
   * discuss a number the estimator has already given, or explain that we do
   * not cover something. Refusing those here would be applying the model's
   * rules to a human and would make the library useless for the cases people
   * actually reach for it.
   */
  it.each([
    ["a price", "Your estimate came to $2,500 as quoted."],
    ["work we do not do", "We don't handle roofing, only the exterior painting."],
  ])("allows %s, which a person may legitimately say", (_label, body) => {
    expect(checkSnippet({ name: "Reply", body })).toEqual([]);
  });
});

describe("keeping a broken one out of the composer", () => {
  it("separates the usable from the rejected", () => {
    const { usable, rejected } = usableSnippets([
      { name: "Good", body: "Hi {{customer_name}}, thanks for getting in touch." },
      { name: "Broken", body: "Hi, {{nope}} will call you." },
    ]);
    expect(usable.map((s) => s.name)).toEqual(["Good"]);
    expect(rejected).toHaveLength(1);
  });
});

/**
 * ── PRECEDENCE ─────────────────────────────────────────────────────────
 *
 * The same tier the standing answers use: a workspace's own snippet beats a
 * shared one of the same name. Hatch's list is generic — "Availability",
 * "Project Details" — and a rep answers threads across workspaces, so shared
 * is the common case.
 */
describe("which snippet wins", () => {
  const shared = (name: string, body: string) => ({ name, body, shared: true });
  const local = (name: string, body: string) => ({ name, body, shared: false });

  it("uses the shared one when the workspace has none of its own", () => {
    const out = resolveSnippets([shared("Availability", "Shared text.")]);
    expect(out.map((s) => s.body)).toEqual(["Shared text."]);
  });

  it("lets the workspace's own beat the shared one", () => {
    const out = resolveSnippets([
      local("Availability", "Local text."),
      shared("availability", "Shared text."),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].body).toBe("Local text.");
  });

  it("treats names differing only by inner spacing as the same", () => {
    // The unique index sees these as different strings, so the database
    // permits both; matching on a plain trim would offer the rep two buttons
    // with the same label saying different things.
    const out = resolveSnippets([
      local("Circling  Back", "Local."),
      shared("Circling Back", "Shared."),
    ]);
    expect(out.map((s) => s.body)).toEqual(["Local."]);
  });

  it("keeps snippets with different names apart", () => {
    const out = resolveSnippets([shared("Availability", "A."), shared("Project Details", "B.")]);
    expect(out).toHaveLength(2);
  });
});

/**
 * ── THE TEST THAT WAS MISSING, AND WHY THE SUITE WAS GREEN WITHOUT IT ───
 *
 * There were precedence tests. There were validity tests. Nothing crossed
 * them, so the loader could resolve precedence BEFORE validating — which puts
 * a broken local snippet first, lets it win its name, and then drops it,
 * taking the good shared snippet of the same name with it because that was
 * already evicted. The rep gets neither, the editor lists both rows as
 * normal, and the only trace is a line in a server log.
 *
 * workspace-faq-db.ts had the identical bug and carries the identical note.
 * Two individually passing groups of tests can miss the interaction between
 * them, which is the whole reason this block exists.
 */
describe("a broken snippet must not take a good one down with it", () => {
  const broken = { name: "Availability", body: "Hi, {{nope}} will call.", shared: false };
  const good = { name: "availability", body: "Shared answer.", shared: true };

  it("keeps the shared one when the local one is invalid", () => {
    // THE ORDER IS THE TEST: validate, then let the survivors compete.
    const out = resolveSnippets(usableSnippets([broken, good]).usable);
    expect(out.map((s) => s.body)).toEqual(["Shared answer."]);
  });

  it("proves the other order loses both — the bug this guards", () => {
    // Resolve first: the broken local wins the name, then validation drops it
    // and the shared one is already gone.
    const wrongWayRound = usableSnippets(resolveSnippets([broken, good])).usable;
    expect(wrongWayRound).toEqual([]);
  });

  it("still prefers the local one when it is valid", () => {
    const ok = { ...broken, body: "Local answer." };
    const out = resolveSnippets(usableSnippets([ok, good]).usable);
    expect(out.map((s) => s.body)).toEqual(["Local answer."]);
  });
});

describe("a name is a button label, so it has a ceiling", () => {
  it("refuses one too long to read at a glance", () => {
    // Nothing capped it — not the check, not the database, not the editor —
    // and the composer renders it in a wrapping row above the reply box, so
    // one long name pushes Send off the screen.
    const problems = checkSnippet({ name: "x".repeat(200), body: "Fine." });
    expect(problems.some((p) => p.field === "name")).toBe(true);
  });

  it("allows the longest name Hatch actually ships", () => {
    // "Estimate Confirmation - In Person" and friends must still fit.
    expect(checkSnippet({ name: "Generic Post Contact Followup", body: "Fine." })).toEqual([]);
  });
});
