import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  draftKey,
  readLocalDraft,
  writeLocalDraft,
  clearLocalDraft,
  draftHasContent,
  mergeDraftIntoState,
  type StoredPick,
} from "@/lib/customer-form/local-draft";

/**
 * The customer form holds everything in React state, so one refresh wipes a
 * 12-room house of colour picks. The worst path is the drift 409: the app tells
 * the customer "please reload the form", which is precisely the action that
 * destroys their work.
 *
 * The restore has to be conservative, because the reason they're reloading is
 * that the job CHANGED. Fresh render decides the shape; the draft only fills in
 * values where the shape still matches.
 */

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

const TOKEN = "tok-abc";

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal("window", { localStorage: memoryStorage() });
});

const pick = (over: Partial<StoredPick> = {}): StoredPick => ({
  colorId: "c1", colorName: "White Dove", colorCode: "OC-17",
  colorHex: "#f0efe6", finish: "eggshell", skipped: false, ...over,
});

describe("local draft round-trip", () => {
  it("saves and restores", () => {
    writeLocalDraft(TOKEN, {
      state: { li1: { picks: { Walls: pick() }, notes: "careful with the piano" } },
      globalNotes: "Friday move-in",
      materialType: "Regal Select Interior",
    });
    const got = readLocalDraft(TOKEN);
    expect(got?.globalNotes).toBe("Friday move-in");
    expect(got?.state.li1.picks.Walls.colorName).toBe("White Dove");
  });

  it("discards a draft older than the retention window", () => {
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
    writeLocalDraft(TOKEN, { state: {}, globalNotes: "stale", materialType: "" }, old);
    expect(readLocalDraft(TOKEN)).toBeNull();
    // And cleans up after itself rather than re-parsing it forever.
    expect(window.localStorage.getItem(draftKey(TOKEN))).toBeNull();
  });

  it("discards a draft written by an older shape", () => {
    window.localStorage.setItem(draftKey(TOKEN), JSON.stringify({ v: 0, state: { li1: {} } }));
    expect(readLocalDraft(TOKEN)).toBeNull();
  });

  it("survives a corrupt entry instead of breaking every future load", () => {
    window.localStorage.setItem(draftKey(TOKEN), "{not json");
    expect(readLocalDraft(TOKEN)).toBeNull();
    expect(window.localStorage.getItem(draftKey(TOKEN))).toBeNull();
  });

  it("degrades quietly when storage is unavailable", () => {
    // Private-browsing configurations throw on the ACCESS, not just the write.
    vi.stubGlobal("window", { get localStorage(): Storage { throw new Error("denied"); } });
    expect(() => writeLocalDraft(TOKEN, { state: {}, globalNotes: "x", materialType: "" })).not.toThrow();
    expect(readLocalDraft(TOKEN)).toBeNull();
    expect(() => clearLocalDraft(TOKEN)).not.toThrow();
  });

  it("does not claim to have restored an untouched form", () => {
    expect(draftHasContent({ state: { li1: { picks: { Walls: pick({ colorId: null, finish: null }) }, notes: "" } }, globalNotes: "", materialType: "" })).toBe(false);
    expect(draftHasContent({ state: {}, globalNotes: "  ", materialType: "" })).toBe(false);
    expect(draftHasContent({ state: {}, globalNotes: "hi", materialType: "" })).toBe(true);
    // A deliberate skip is content too — it's an answer.
    expect(draftHasContent({ state: { li1: { picks: { Walls: pick({ colorId: null, finish: null, skipped: true }) }, notes: "" } }, globalNotes: "", materialType: "" })).toBe(true);
  });
});

describe("merging a draft onto a changed job (the drift-reload path)", () => {
  const base: Record<string, { picks: Record<string, StoredPick>; notes: string }> = {
    li1: { picks: { Walls: pick({ colorId: null, colorName: null, finish: null }), Ceiling: pick({ colorId: null, colorName: null, finish: null }) }, notes: "" },
    li2: { picks: { Trim: pick({ colorId: null, colorName: null, finish: null }) }, notes: "" },
  };

  it("restores values for rooms and surfaces that still exist", () => {
    const { state, restoredRooms } = mergeDraftIntoState(base, {
      state: { li1: { picks: { Walls: pick() }, notes: "piano" } },
    });
    expect(state.li1.picks.Walls.colorName).toBe("White Dove");
    expect(state.li1.notes).toBe("piano");
    expect(restoredRooms).toBe(1);
    // Untouched rooms keep the fresh seed.
    expect(state.li2.picks.Trim.colorId).toBeNull();
  });

  it("drops picks for a room the rep deleted", () => {
    const { state, droppedRooms } = mergeDraftIntoState(base, {
      state: { liGONE: { picks: { Walls: pick() }, notes: "" } },
    });
    expect(droppedRooms).toEqual(["liGONE"]);
    expect(state).not.toHaveProperty("liGONE");
    // Re-submitting a room that no longer exists would just trip drift again.
    expect(Object.keys(state).sort()).toEqual(["li1", "li2"]);
  });

  it("drops a surface the rep removed but keeps the rest of the room", () => {
    const { state } = mergeDraftIntoState(base, {
      state: { li1: { picks: { Walls: pick(), Wainscoting: pick({ colorName: "Simply White" }) }, notes: "" } },
    });
    expect(state.li1.picks.Walls.colorName).toBe("White Dove");
    expect(state.li1.picks).not.toHaveProperty("Wainscoting");
  });

  it("leaves a room the rep ADDED empty for the customer to fill", () => {
    const withNewRoom = { ...base, li3: { picks: { Walls: pick({ colorId: null, colorName: null, finish: null }) }, notes: "" } };
    const { state } = mergeDraftIntoState(withNewRoom, {
      state: { li1: { picks: { Walls: pick() }, notes: "" } },
    });
    expect(state.li3.picks.Walls.colorId).toBeNull();
  });

  it("ignores a malformed pick rather than writing undefined into the form", () => {
    const { state } = mergeDraftIntoState(base, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      state: { li1: { picks: { Walls: null as any }, notes: "" } },
    });
    expect(state.li1.picks.Walls).toBeDefined();
    expect(state.li1.picks.Walls.colorId).toBeNull();
  });
});
