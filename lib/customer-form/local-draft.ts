/**
 * Crash-proofing for the customer color form.
 *
 * Everything a customer types lives in React state and nowhere else, so it is
 * one refresh away from gone. That matters here more than on most forms:
 *
 *  - A drift 409 ("our team just updated your job — please reload the form")
 *    tells the customer to do the one thing that destroys their work. On a
 *    12-room house that is 30+ color and finish picks, re-entered by hand.
 *  - iOS Safari evicts backgrounded tabs aggressively. A phone call in the
 *    middle of filling this in is enough.
 *  - The form is long. Accidental back-navigation on a phone is easy.
 *
 * So: mirror the in-progress form to localStorage, keyed by the token that is
 * already in the URL (no new exposure), and restore it on the next load.
 *
 * The restore is deliberately conservative. It only re-applies picks for rooms
 * and surfaces that STILL EXIST in the freshly-rendered form, which is exactly
 * what makes it safe on the drift path: a room the rep deleted drops out, a
 * room the rep added comes back empty for the customer to fill, and a room
 * whose surfaces changed keeps only the surfaces that survived. The customer
 * never re-submits a stale shape.
 *
 * Storage can be unavailable (private mode, disabled cookies, quota) — every
 * entry point degrades to "no draft" rather than breaking the form.
 */

export type StoredPick = {
  colorId: string | null;
  colorName: string | null;
  colorCode: string | null;
  colorHex: string | null;
  finish: string | null;
  skipped: boolean;
};

export type StoredLineItem = {
  picks: Record<string, StoredPick>;
  notes: string;
};

export type LocalDraft = {
  /** Bump when the shape changes; anything else is discarded, not migrated. */
  v: 1;
  savedAt: string;
  state: Record<string, StoredLineItem>;
  globalNotes: string;
  materialType: string;
};

const VERSION = 1;
/** Older than this and the job has almost certainly moved on. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function draftKey(token: string): string {
  return `ppp:color-form-draft:${token}`;
}

function storage(): Storage | null {
  try {
    // Reading `localStorage` itself throws in some privacy configurations —
    // the access, not just the operation, has to be guarded.
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readLocalDraft(token: string, now: number = Date.now()): LocalDraft | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(draftKey(token));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocalDraft>;
    if (parsed?.v !== VERSION || !parsed.state || typeof parsed.state !== "object") return null;
    const savedMs = Date.parse(parsed.savedAt ?? "");
    if (Number.isNaN(savedMs) || now - savedMs > MAX_AGE_MS) {
      clearLocalDraft(token);
      return null;
    }
    return {
      v: VERSION,
      savedAt: parsed.savedAt!,
      state: parsed.state as Record<string, StoredLineItem>,
      globalNotes: typeof parsed.globalNotes === "string" ? parsed.globalNotes : "",
      materialType: typeof parsed.materialType === "string" ? parsed.materialType : "",
    };
  } catch {
    // Corrupt entry — drop it rather than letting it fail every future load.
    clearLocalDraft(token);
    return null;
  }
}

export function writeLocalDraft(
  token: string,
  draft: Omit<LocalDraft, "v" | "savedAt">,
  now: number = Date.now()
): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(
      draftKey(token),
      JSON.stringify({ v: VERSION, savedAt: new Date(now).toISOString(), ...draft })
    );
  } catch {
    // Quota exceeded or storage blocked mid-session. The form still works; it
    // just loses its safety net. Failing loudly here would be worse than the
    // problem — the customer can't act on it.
  }
}

export function clearLocalDraft(token: string): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(draftKey(token));
  } catch {
    /* nothing useful to do */
  }
}

/** True if the customer actually put something in — an untouched form
 *  autosaves its empty seed state and must not then claim to have restored it. */
export function draftHasContent(draft: Pick<LocalDraft, "state" | "globalNotes" | "materialType">): boolean {
  if (draft.globalNotes.trim() || draft.materialType.trim()) return true;
  for (const li of Object.values(draft.state)) {
    if (li.notes?.trim()) return true;
    for (const p of Object.values(li.picks ?? {})) {
      if (p.colorId || p.finish || p.skipped) return true;
    }
  }
  return false;
}

/**
 * Overlay a saved draft onto freshly-seeded form state.
 *
 * `base` is the source of truth for SHAPE — which rooms exist and which
 * surfaces each has. The draft only supplies VALUES, and only where the shape
 * still matches. Returns the merged state plus what had to be dropped, so the
 * UI can be honest about it instead of silently losing a room.
 */
export function mergeDraftIntoState<T extends { picks: Record<string, StoredPick>; notes: string }>(
  base: Record<string, T>,
  draft: Pick<LocalDraft, "state">
): { state: Record<string, T>; restoredRooms: number; droppedRooms: string[] } {
  const merged: Record<string, T> = {};
  let restoredRooms = 0;
  const droppedRooms: string[] = [];

  for (const [lineId, saved] of Object.entries(draft.state)) {
    if (!base[lineId]) droppedRooms.push(lineId);
  }

  for (const [lineId, baseLine] of Object.entries(base)) {
    const saved = draft.state[lineId];
    if (!saved) {
      merged[lineId] = baseLine;
      continue;
    }
    const picks = { ...baseLine.picks };
    let touched = false;
    for (const [surface, pick] of Object.entries(saved.picks ?? {})) {
      // A surface the rep removed is not restored — it no longer exists on the
      // work order, and submitting it would fail drift detection all over again.
      if (!(surface in picks)) continue;
      if (!pick || typeof pick !== "object") continue;
      picks[surface] = {
        colorId: pick.colorId ?? null,
        colorName: pick.colorName ?? null,
        colorCode: pick.colorCode ?? null,
        colorHex: pick.colorHex ?? null,
        finish: pick.finish ?? null,
        skipped: !!pick.skipped,
      };
      touched = true;
    }
    const notes = typeof saved.notes === "string" ? saved.notes : baseLine.notes;
    if (notes !== baseLine.notes) touched = true;
    merged[lineId] = { ...baseLine, picks, notes };
    if (touched) restoredRooms += 1;
  }

  return { state: merged, restoredRooms, droppedRooms };
}
