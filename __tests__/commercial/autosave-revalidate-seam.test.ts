import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The autosave/revalidate seam.
 *
 * Stephanie 2026-08-13: *"it automatically saves every 3 seconds making it hard
 * to enter data without it being overwritten or erased."* The fix is a flag the
 * CLIENT sets and the SERVER reads, so a background save writes without
 * re-rendering the page the user is typing into.
 *
 * That is a list maintained in two places, and the second place is invisible to
 * TypeScript — both sides only agree on a string literal. Rename it on either
 * side and nothing fails to compile, no test breaks, and the proposal editor
 * quietly goes back to eating Kim's typing. This is the same seam class as the
 * team-roles CHECK constraint (136) and the inline-field render list.
 *
 * So: assert the literal matches on both sides, and that the server actually
 * returns early on it.
 */

const ROOT = join(__dirname, "..", "..");
const CLIENT = join(ROOT, "components/commercial/autosave-proposal-form.tsx");
const SERVER = join(
  ROOT,
  "app/commercial/accounts/[id]/deals/[dealId]/proposal/[proposalId]/page.tsx"
);

const FLAG = "__autosave";

describe("autosave → revalidate seam", () => {
  it("the client marks background saves with the flag", () => {
    const src = readFileSync(CLIENT, "utf8");
    expect(src).toContain(`fd.set("${FLAG}", "1")`);
  });

  it("the client sends the tagged FormData, not a fresh one", () => {
    // The flag is useless if fireSave rebuilds FormData after setting it —
    // which is exactly how this would regress during a refactor.
    const src = readFileSync(CLIENT, "utf8");
    expect(src).toContain("void wrappedAction(fd)");
    expect(src).not.toContain("void wrappedAction(new FormData(");
  });

  it("the server skips revalidation when the flag is set", () => {
    const src = readFileSync(SERVER, "utf8");
    expect(src).toContain(`formData.get("${FLAG}")`);
    // The early return must come BEFORE the revalidatePath calls, or the flag
    // is read and then ignored.
    const guard = src.indexOf(`formData.get("${FLAG}")`);
    const revalidate = src.indexOf("revalidatePath(", guard);
    expect(guard).toBeGreaterThan(-1);
    expect(revalidate).toBeGreaterThan(guard);
    expect(src.slice(guard, revalidate)).toContain("return");
  });

  it("an explicit save still revalidates the sibling pages", () => {
    // Skipping revalidation on autosave is only safe because a real save
    // still refreshes the proposals list and the account page.
    const src = readFileSync(SERVER, "utf8");
    expect(src).toContain('revalidatePath("/commercial/proposals")');
    expect(src).toContain("revalidatePath(`/commercial/accounts/${accountId}`)");
  });

  it("the debounce stays long enough to fire between thoughts, not words", () => {
    const src = readFileSync(CLIENT, "utf8");
    const m = src.match(/debounceMs\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(2000);
  });
});

describe("both autosave components clear their debounce ref", () => {
  it("neither leaves a stale timer id for beforeunload to trip over", () => {
    // A one-shot setTimeout handle is always truthy and setTimeout never nulls
    // it. The beforeunload guard reads `timerRef.current`, so forgetting this
    // line means "Leave site? Changes you made may not be saved" fires on
    // every navigation forever after the first keystroke — long after the pill
    // says Saved. autosave-form.tsx always had the line; its sibling did not.
    for (const f of [
      "components/commercial/autosave-proposal-form.tsx",
      "components/commercial/autosave-form.tsx",
    ]) {
      const src = readFileSync(join(ROOT, f), "utf8");
      const at = src.indexOf("function fireSave()");
      expect(at, `${f}: no fireSave`).toBeGreaterThan(-1);
      const body = src.slice(at, at + 900);
      expect(body, `${f}: fireSave never nulls timerRef`).toContain("timerRef.current = null");
      // And it must happen before any early return, or a disabled form leaves
      // the stale id behind.
      const nullAt = body.indexOf("timerRef.current = null");
      const firstReturn = body.indexOf("return");
      expect(nullAt, `${f}: timerRef cleared after an early return`).toBeLessThan(firstReturn);
    }
  });
});
