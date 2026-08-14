import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTOSAVE_FLAG, AUTOSAVE_DEBOUNCE_MS, isBackgroundSave } from "@/lib/commercial/autosave-flag";

/**
 * The autosave/revalidate seam.
 *
 * Stephanie 2026-08-13: *"it automatically saves every 3 seconds making it hard
 * to enter data without it being overwritten or erased."* The fix is a flag the
 * CLIENT sets and the SERVER reads, so a background save writes without
 * re-rendering the page the user is typing into.
 *
 * The earlier version of this file asserted the string literal `"__autosave"`
 * appeared in the proposal editor and its wrapper. It passed continuously while
 * the bug was live on TWO OTHER SURFACES: when the pattern was generalized into
 * `AutosaveForm` for the Work Order and Closeout tools, the flag was not
 * carried across, and both kept revalidating on every keystroke. A test that
 * only knows about the surface the bug was first reported on cannot catch the
 * second surface — so this file now enumerates EVERY autosaving pair and fails
 * when a new one is added without the guard.
 *
 * If you add an autosaving surface, add it to WRAPPERS or ACTIONS below. That
 * is the point: the list is the test.
 */

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Every client wrapper that fires debounced background saves. */
const WRAPPERS = [
  "components/commercial/autosave-proposal-form.tsx",
  "components/commercial/autosave-form.tsx",
];

/**
 * Every server action wired to one of those wrappers, with the revalidate
 * helper it must not reach on a background save.
 */
const ACTIONS = [
  {
    file: "app/commercial/accounts/[id]/deals/[dealId]/proposal/[proposalId]/page.tsx",
    action: "saveProposalAction",
    revalidator: "revalidatePath(",
  },
  {
    file: "app/commercial/accounts/[id]/work-order/[dealId]/work-order-tool.tsx",
    action: "autosaveWorkOrderAction",
    revalidator: "revalidateWO(",
  },
  {
    file: "app/commercial/accounts/[id]/closeout/[dealId]/closeout-tool.tsx",
    action: "autosaveCoverAction",
    revalidator: "revalidateCloseout(",
  },
];

describe("autosave flag helper", () => {
  it("only treats an explicit '1' as a background save", () => {
    const bg = new FormData();
    bg.set(AUTOSAVE_FLAG, "1");
    expect(isBackgroundSave(bg)).toBe(true);

    // A human submit posts no flag at all — that must revalidate.
    expect(isBackgroundSave(new FormData())).toBe(false);

    // And nothing else counts, so a stray value can't silently suppress the
    // refresh on a real save.
    for (const v of ["0", "", "true", "on"]) {
      const fd = new FormData();
      fd.set(AUTOSAVE_FLAG, v);
      expect(isBackgroundSave(fd), `value ${JSON.stringify(v)}`).toBe(false);
    }
  });

  it("debounces on the pause between thoughts, not between words", () => {
    expect(AUTOSAVE_DEBOUNCE_MS).toBeGreaterThanOrEqual(2000);
  });
});

describe("every autosave wrapper tags its background saves", () => {
  for (const f of WRAPPERS) {
    it(`${f} sets the shared flag`, () => {
      const src = read(f);
      // Imported, not retyped — a literal here is how the two wrappers drifted.
      expect(src, "must import the shared constant").toContain(
        'from "@/lib/commercial/autosave-flag"'
      );
      expect(src).toContain(`fd.set(AUTOSAVE_FLAG, "1")`);
      expect(src, "hardcoded literal defeats the shared constant").not.toContain(
        `fd.set("__autosave"`
      );
    });

    it(`${f} sends the tagged FormData, not a fresh one`, () => {
      // The flag is useless if fireSave rebuilds FormData after setting it —
      // which is exactly how this would regress during a refactor.
      const src = read(f);
      expect(src).toContain("void wrappedAction(fd)");
      expect(src).not.toContain("void wrappedAction(new FormData(");
    });

    it(`${f} uses the shared debounce`, () => {
      const src = read(f);
      expect(src).toContain("debounceMs = AUTOSAVE_DEBOUNCE_MS");
    });

    it(`${f} clears its debounce ref before any early return`, () => {
      // A one-shot setTimeout handle is always truthy and setTimeout never nulls
      // it. The beforeunload guard reads `timerRef.current`, so forgetting this
      // line means "Leave site? Changes you made may not be saved" fires on
      // every navigation forever after the first keystroke — long after the pill
      // says Saved. autosave-form.tsx always had the line; its sibling did not.
      const src = read(f);
      const at = src.indexOf("function fireSave()");
      expect(at, `${f}: no fireSave`).toBeGreaterThan(-1);
      const body = src.slice(at, at + 1200);
      expect(body, `${f}: fireSave never nulls timerRef`).toContain("timerRef.current = null");
      const nullAt = body.indexOf("timerRef.current = null");
      const firstReturn = body.indexOf("return");
      expect(nullAt, `${f}: timerRef cleared after an early return`).toBeLessThan(firstReturn);
    });

    it(`${f} re-throws NEXT_REDIRECT instead of swallowing it`, () => {
      // A bare `catch {}` eats the redirect control signal, so the page sits in
      // a state it cannot leave and every later autosave hits the same
      // conflict. Karan 2026-08-13: "it boots us out and won't let us go back
      // into it. This cannot happen whatsoever."
      const src = read(f);
      expect(src).toContain("NEXT_REDIRECT");
    });
  }
});

describe("every autosave action skips revalidation on a background save", () => {
  for (const { file, action, revalidator } of ACTIONS) {
    it(`${action} guards before ${revalidator}`, () => {
      const src = read(file);
      const start = src.indexOf(`function ${action}(`);
      expect(start, `${file}: no ${action}`).toBeGreaterThan(-1);

      // Scope to this action's body so a guard in a NEIGHBOURING action can't
      // make this pass — the exact way an earlier structural test in this repo
      // read the wrong statement and stayed green while broken.
      const nextFn = src.indexOf("\nasync function ", start + 1);
      const body = src.slice(start, nextFn === -1 ? src.length : nextFn);

      const guard = body.indexOf("isBackgroundSave(formData)");
      expect(guard, `${action}: no isBackgroundSave guard`).toBeGreaterThan(-1);

      const revalidate = body.indexOf(revalidator);
      expect(revalidate, `${action}: no ${revalidator} to guard`).toBeGreaterThan(-1);
      expect(
        guard,
        `${action}: the guard is read AFTER the revalidate, so it does nothing`
      ).toBeLessThan(revalidate);
      expect(
        body.slice(guard, revalidate),
        `${action}: guard doesn't return before revalidating`
      ).toContain("return");
    });

    it(`${action} still performs the WRITE on a background save`, () => {
      // Skipping the write instead of the revalidate would turn autosave into
      // "silently discard everything typed" — a far worse bug than the one
      // being fixed, and an easy one to introduce by hoisting the guard.
      const src = read(file);
      const start = src.indexOf(`function ${action}(`);
      const nextFn = src.indexOf("\nasync function ", start + 1);
      const body = src.slice(start, nextFn === -1 ? src.length : nextFn);
      const guard = body.indexOf("isBackgroundSave(formData)");
      const before = body.slice(0, guard);
      expect(
        /await (update|save|upsert)/i.test(before),
        `${action}: the guard sits BEFORE the write — autosave would save nothing`
      ).toBe(true);
    });
  }
});
