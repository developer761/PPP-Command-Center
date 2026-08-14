/**
 * The autosave ↔ revalidate seam, in ONE place.
 *
 * Stephanie 2026-08-13: *"it automatically saves every 3 seconds making it hard
 * to enter data without it being overwritten or erased."* A background save
 * that calls `revalidatePath` ships a fresh RSC payload back with the action
 * response, and Next re-renders the tree the user is currently typing into.
 * The cure is a flag the CLIENT sets and the SERVER reads, so a debounced save
 * writes without re-rendering.
 *
 * This lived as a bare string literal in the proposal editor, matched by eye
 * against the same literal in its client wrapper. That is a list maintained in
 * two places where the second place is invisible to TypeScript — the same seam
 * class as the team-roles CHECK constraint (136) and the inline-field render
 * list, and it went on to bite exactly as predicted: when the pattern was
 * generalized into `AutosaveForm` for the Work Order and Closeout tools, the
 * flag was simply not carried across, so both of those surfaces kept
 * revalidating on every keystroke and Stephanie's complaint stayed live on them
 * for a month after it was "fixed".
 *
 * Importing the constant is not merely tidier — it is the only version of this
 * that a rename cannot silently break. NOTE: this module must stay free of
 * `server-only`; the client wrappers import it too.
 */

/** FormData key marking a save as a background/debounced one. */
export const AUTOSAVE_FLAG = "__autosave";

/**
 * True when this save came from the debounce timer rather than a human pressing
 * something. Server actions use it to skip `revalidatePath` — and ONLY that.
 * The write itself must still happen, or autosave is not saving.
 */
export function isBackgroundSave(formData: FormData): boolean {
  return formData.get(AUTOSAVE_FLAG) === "1";
}

/**
 * Debounce for every autosaving surface.
 *
 * 800ms — the original value — fires on the pause between two words rather than
 * the pause between two thoughts, so a save (and, before this seam existed, a
 * re-render) landed mid-sentence constantly. 2.5s still saves far faster than
 * anyone loses work to a closed laptop, and `beforeunload` covers the gap.
 */
export const AUTOSAVE_DEBOUNCE_MS = 2500;
