import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
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
 * Every server action wired to one of those wrappers — DISCOVERED, not listed.
 *
 * This started as a hand-written list of three and was wrong within the hour:
 * it missed `saveCoverAutosaveAction` on the submittals page, which revalidated
 * the very route it was being typed into ("the submittals page is autosaving
 * and it boots us out"). A list of known surfaces cannot catch the surface
 * nobody remembered, which is the whole failure mode being defended against
 * here. So walk the tree, find everything wired to an autosave wrapper, and
 * make a NEW surface fail this test by default rather than pass by omission.
 */
function discoverAutosaveActions(): { file: string; action: string }[] {
  const out: { file: string; action: string }[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== ".next") walk(p);
      } else if (e.name.endsWith(".tsx")) {
        const src = readFileSync(p, "utf8");
        const re = /<Autosave(?:Proposal)?Form\b[^>]*?\saction=\{([A-Za-z0-9_$]+)\}/g;
        for (const m of src.matchAll(re)) {
          const rel = relative(ROOT, p);
          if (!out.some((x) => x.file === rel && x.action === m[1])) {
            out.push({ file: rel, action: m[1] });
          }
        }
      }
    }
  };
  walk(join(ROOT, "app"));
  return out;
}

const ACTIONS = discoverAutosaveActions();
/** Any call that triggers a re-render of the tree being typed into. */
const REVALIDATE_RE = /revalidate[A-Za-z]*\(/;

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

/** The action's body, scoped so a NEIGHBOURING action's guard can't satisfy it —
 *  the exact way an earlier structural test in this repo read the wrong
 *  statement and stayed green while the code it guarded was broken. */
function bodyOf(file: string, action: string): string {
  const src = read(file);
  const start = src.indexOf(`function ${action}(`);
  expect(start, `${file}: no ${action}`).toBeGreaterThan(-1);
  const nextFn = src.indexOf("\nasync function ", start + 1);
  return src.slice(start, nextFn === -1 ? src.length : nextFn);
}

describe("no autosave component swallows the redirect signal", () => {
  /**
   * A server action reports failure by redirecting to ?error=, which throws
   * NEXT_REDIRECT. A bare catch eats it, so the navigation never happens, the
   * pill lies, and the page sits in a state it cannot leave — Karan: "it boots
   * us out and won't let us go back into it."
   *
   * This was found and fixed on autosave-proposal-form, then again on
   * autosave-form, and a THIRD copy (autosave-proposal-name) still had it,
   * because each was written from the previous one's template. Discovered by
   * filename so a fourth copy fails the moment it is added.
   */
  const components = readdirSync(join(ROOT, "components/commercial"))
    .filter((f) => /autosave.*\.tsx$/.test(f))
    .map((f) => `components/commercial/${f}`);

  it("found the autosave components", () => {
    expect(components.length).toBeGreaterThanOrEqual(3);
  });

  for (const f of components) {
    it(`${f.split("/").pop()} re-throws NEXT_REDIRECT`, () => {
      const src = read(f);
      // Anchor on the CHECK, not the first mention — every one of these files
      // explains itself in a comment first, so indexOf("NEXT_REDIRECT") lands
      // in prose and the re-throw is well past a fixed window.
      const at = src.indexOf('.startsWith("NEXT_REDIRECT")');
      expect(at, `${f}: no NEXT_REDIRECT check — a catch here eats the redirect`).toBeGreaterThan(-1);
      // Recognising it is not enough: it has to actually re-throw.
      expect(src.slice(at, at + 200), `${f}: recognises NEXT_REDIRECT but doesn't re-throw`).toContain("throw err");
    });
  }
});

describe("every autosave action skips revalidation on a background save", () => {
  it("found the autosaving surfaces at all", () => {
    // If the discovery regex stops matching (a wrapper is renamed, the action
    // is passed differently), every test below would vacuously pass over an
    // empty list. Fail loudly instead.
    expect(ACTIONS.length).toBeGreaterThanOrEqual(4);
  });

  for (const { file, action } of ACTIONS) {
    it(`${action} (${file.split("/").slice(-2).join("/")}) guards before revalidating`, () => {
      const body = bodyOf(file, action);
      const m = body.match(REVALIDATE_RE);
      if (!m) return; // nothing to revalidate → nothing to guard.

      const guard = body.indexOf("isBackgroundSave(formData)");
      expect(guard, `${action}: no isBackgroundSave guard`).toBeGreaterThan(-1);

      const revalidate = body.indexOf(m[0]);
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
      const body = bodyOf(file, action);
      const guard = body.indexOf("isBackgroundSave(formData)");
      if (guard === -1) return; // covered by the test above.
      expect(
        /await (\w*\.)?(update|save|edit|upsert)/i.test(body.slice(0, guard)),
        `${action}: the guard sits BEFORE the write — autosave would save nothing`
      ).toBe(true);
    });
  }
});
